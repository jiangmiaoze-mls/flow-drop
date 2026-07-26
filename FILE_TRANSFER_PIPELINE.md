# 文件传输链路技术文档

## 1. 范围与结论

本文描述当前 `mobile -> Windows Agent` 文件传输实现，从用户选择文件到 Agent 完整落盘的链路。内容基于当前代码，不将尚未完成的 Agent -> mobile 方向、后台持续传输、文件加密或未完成的真机性能测试表述为已实现。

当前实现的关键约束如下：

- 发送端是移动端，接收端是 Windows Agent；Web 管理页只显示 Agent 已创建的接收任务。
- 文件任务在移动端 SQLite 中排队；Agent 仅在收到创建请求后才知道该任务。
- 新任务使用 4 MiB 分块和最多 4 个在途请求的滑动窗口；单任务峰值在途二进制数据约为 16 MiB。
- Agent 对每个传输任务持久化分块大小；历史任务默认使用 1 MiB，以避免升级后错误解释断点偏移。
- 文件完整性由 Agent 对完整 SHA-256 的最终校验保证；每个分块也带 SHA-256。

## 2. 状态机

```text
选择文件
  -> preparing       解析中：移动、计算 SHA-256、记录解析进度
  -> queued          待传输：元数据与暂存文件已就绪
  -> negotiating     正在协商：向 Agent 创建或恢复接收任务
  -> transferring    传输中：至少一个分块已被 Agent 确认
  -> verifying       Agent 校验完整文件
  -> completed       Agent 原子落盘成功，移动端标记完成

非终态 -> paused     用户暂停
非终态 -> cancelled  用户取消
网络超时/不可达 -> waiting_for_peer
协议、文件、认证等不可恢复错误 -> failed
```

`completed` 与 `cancelled` 不显示在“当前传输”，但仍保留在移动端 SQLite 历史。`failed` 保留重发入口。

## 3. 数据与持久化

### 3.1 移动端

移动端数据库为 `flowdrop.sqlite`，包含：

- `outgoing_transfers`：目标设备地址、状态、总字节、已处理或已确认字节、失败码、时间。
- `outgoing_transfer_items`：文件名、MIME、完整 SHA-256、暂存 URI、项目状态与字节数。

文件解析占位项使用全零的 64 位十六进制 SHA-256 标识。该标识不能依赖文件大小，因为 `DocumentPicker` 已知文件大小时，解析尚未完成的任务也会有非零总大小。

### 3.2 Agent

Agent 在 `%LOCALAPPDATA%\FlowDrop\transfers` 保存：

- `transfers.sqlite`：接收任务、项目、已确认分块和每个任务的 `chunk_size_bytes`。
- `staging\<transferId>\<itemId>.part`：未完成文件。
- `incoming\`：完整校验通过后的最终文件。

Agent 启动时会为旧数据库补充 `chunk_size_bytes` 列，默认值为 1 MiB；新任务由创建请求声明 4 MiB。

## 4. 选择与解析

1. 页面调用 `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true })`。
2. 每个选择结果立即创建一条移动端任务，状态为 `preparing`，因此多选文件无需等待前一个文件解析完成才出现在队列中。
3. `DocumentPicker` 已将内容复制到应用缓存。准备器将该缓存 URI 移动到应用文档目录的 `flowdrop-outgoing`，避免再复制一次大文件。
4. 准备器计算完整 SHA-256 和最终文件大小，并持续更新 SQLite 中的 `transferredBytes`。在 `preparing` 状态下，该字段表示“已解析字节”，不是已上传字节。
5. Android 新 development build 使用 `@flowdrop/network` 的 `sha256FileAsync`：原生 `MessageDigest` 在 I/O 协程内流式读取，每处理 4 MiB 才发送一次进度事件。JS 线程只接收事件并刷新页面。
6. 原生模块不存在时，移动端回退到 JS 增量哈希。该回退使用较小分块，兼容性优先，不是 Android 大文件性能路径。
7. SHA-256 成功后，任务以事务替换为最终项目元数据，状态变为 `queued`，随后触发 FIFO 发送器。

解析阶段尚未调用 Agent，所以 Web 页面不会显示“解析中”或“待传输”任务。

## 5. 协商与认证

出队时移动端将任务状态乐观更新为 `negotiating`，随后执行：

```text
POST http://<Agent IP>:<controlPort>/v1/transfers
```

请求包含：

- `transferId`、`sourceDeviceId`、项目清单、每个项目的完整 SHA-256 与字节数。
- `chunkSizeBytes`：新任务为 4 MiB。
- HMAC-SHA-256 认证头：签名覆盖 HTTP 方法、路径、时间戳、nonce 与请求体 SHA-256。

Agent 校验可信设备、接收许可、HMAC、时间窗口与 nonce 重放后，在 SQLite 创建或返回同一 `transferId` 的任务。创建响应包含：

- Agent 实际采用的 `chunkSizeBytes`。
- 每个项目的 `receivedBytes`。
- 每个项目已持久化的 `receivedChunkIndexes`。

移动端必须使用响应中的分块大小和已确认索引，而不是假设当前版本常量。这样旧 1 MiB 任务在新客户端上仍能续传。

协商请求的超时为 15 秒。应用层用 Promise 竞速保证即使原生 `fetch` 没有及时响应取消信号，队列也会从等待中释放并转为 `waiting_for_peer`。

## 6. 分块上传与窗口控制

协商成功后，移动端确认暂存文件仍存在且文件大小未变化。不会再次完整哈希该私有暂存文件：其完整摘要已在解析阶段生成，Agent 仍会在完成阶段验证完整文件。

每个缺失分块使用：

```text
PUT /v1/transfers/:transferId/items/:itemId/chunks/:chunkIndex
Content-Range: bytes <start>-<end>/<total>
X-FlowDrop-Chunk-Sha256: <chunk digest>
```

发送器维护最多 4 个在途 PUT 请求：

1. 读取一个尚未确认的分块，计算块摘要并发出 PUT。
2. 窗口未满时继续提交后续分块，不等待前一块 HTTP 响应。
3. Agent 确认块已持久化后，移动端才将该块字节计入上传进度。
4. 任一请求失败后，发送器停止补充窗口并以失败码更新任务。
5. 任务恢复时，移动端按 Agent 返回的已确认索引跳过已落盘分块，只补发缺块。

这不是按秒限速。窗口大小和分块大小仍构成流控上限，目的是限制内存与接收端写入压力；吞吐量还受 Wi-Fi、HTTP 实现、Agent 磁盘、Agent 事件循环和每个请求延迟影响。

## 7. Agent 接收与完成

对每个块，Agent：

1. 重新检查来源设备与接收许可。
2. 验证分块大小、索引、`Content-Range` 和块 SHA-256。
3. 将块写到 `.part` 文件的 `chunkIndex * chunkSizeBytes` 偏移。
4. 将块索引、长度和摘要写入 SQLite；重复的同内容块幂等返回，冲突块拒绝。
5. 发布 `transfer.changed` SSE，Web 收到事件后重新读取 `/api/transfers`。

移动端等待所有在途分块确认后调用：

```text
POST /v1/transfers/:transferId/complete
```

Agent 检查每个项目已收字节数与声明大小一致，对 `.part` 文件计算完整 SHA-256。成功后将文件原子移动到 `incoming`，更新项目与任务为 `completed`，并发布 SSE。只有收到该完成响应，移动端才把自己的任务标记为 `completed`。

## 8. 暂停、继续与取消

暂停、继续、取消使用已认证的 `/pause`、`/resume`、`/cancel` 接口。移动端先乐观写 SQLite 和 UI，再等待 Agent 响应：

- Agent 成功：两端持久化相同状态，Web 通过 SSE 刷新。
- Agent 返回 `TRANSFER_NOT_FOUND`：视为接收端从未收到该任务的极端情况，保留本地乐观状态；继续会重新创建接收任务。
- 其它错误：移动端回滚到可继续状态并显示错误。

Agent 在暂停或终态后拒绝迟到的分块和完成请求，避免并发请求把任务状态重新写回 `transferring`。

## 9. 已验证与未验证

已通过静态检查：移动端 TypeScript、Windows Agent TypeScript、差异空白检查。

尚未完成或尚未验证：

- Android 原生 Kotlin 模块的实际编译与 100MiB 文件真机性能。
- 新 4MiB/4 窗口协议的移动端到 Agent 端到端吞吐、暂停、恢复、取消和网络竞态。
- 旧 Agent 进程必须重启，移动端必须重新构建安装；旧开发包会缺少原生哈希方法并走 JS 回退。
- 文件内容仍经明文 HTTP 传输；HMAC 不提供内容机密性，也不能防御不安全初次配对中的中间人。
- 没有自动重试、带宽自适应、后台持续传输、过期暂存清理或 Agent -> mobile 文件接收。
