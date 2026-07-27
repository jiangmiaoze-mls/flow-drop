# 文件传输链路技术文档

## 1. 范围与结论

本文描述当前 `mobile -> Windows Agent` 文件传输实现，从用户选择文件到 Agent 完整落盘的链路。内容基于当前代码，不将尚未完成的 Agent -> mobile 方向、后台持续传输、文件加密或未完成的真机性能测试表述为已实现。

当前实现的关键约束如下：

- 发送端是移动端，接收端是 Windows Agent；Web 管理页只显示 Agent 已创建的接收任务。
- 文件任务在移动端 SQLite 中排队；Agent 仅在收到创建请求后才知道该任务。
- 新任务使用 1 MiB 分块和最多 4 个在途请求的滑动窗口。React Native 中 HMAC 与 `fetch` 可能复制请求体，因此总在途二进制数据仍限制为约 4 MiB；它不是按秒限速。
- Agent 对每个传输任务持久化分块大小；历史任务默认使用 1 MiB，以避免升级后错误解释断点偏移。
- 新建文件任务使用协议 `v2`：发送端在分块读取和上传的同一遍 I/O 中计算完整 SHA-256，完成请求再携带摘要；每个分块仍带 SHA-256。Agent 保留 `v1` 接收兼容。

## 2. 状态机

```text
选择文件
  -> preparing       解析中：移动进应用私有发送目录、记录准备进度
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

- `outgoing_transfers`：目标设备地址、状态、总字节、`preparedBytes`、`transferredBytes`、失败码、时间。
- `outgoing_transfer_items`：文件名、MIME、暂存 URI、项目状态与各自的准备/已确认传输字节。文件的完整 SHA-256 在 `v2` 上传过程中生成后回写。

文件解析占位项使用全零的 64 位十六进制 SHA-256 标识。该标识不能依赖文件大小，因为 `DocumentPicker` 已知文件大小时，解析尚未完成的任务也会有非零总大小。

### 3.2 Agent

Agent 在 `%LOCALAPPDATA%\FlowDrop\transfers` 保存：

- `transfers.sqlite`：接收任务、项目、已确认分块和每个任务的 `chunk_size_bytes`。
- `staging\<transferId>\<itemId>.part`：未完成文件。
- `incoming\`：完整校验通过后的最终文件。

Agent 启动时会为旧数据库补充 `chunk_size_bytes` 列，默认值为 1 MiB；新任务也声明 1 MiB。已经创建的 4 MiB 任务必须保持原分块大小，不能在原任务上改写。

## 4. 选择与解析

1. 页面调用 `DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true })`。
2. 每个选择结果立即创建一条移动端任务，状态为 `preparing`，因此多选文件无需等待前一个文件解析完成才出现在队列中。
3. `DocumentPicker` 已将内容复制到应用缓存。准备器将该缓存 URI 移动到应用文档目录的 `flowdrop-outgoing`，避免再复制一次大文件。
4. 准备器不再预计算完整 SHA-256，也不读取文件内容；移动成功后以最终文件大小更新 `preparedBytes`，任务立即变为 `queued`。
5. `preparedBytes` 与 `transferredBytes` 分列存储，前者不会再被上传确认进度覆盖。
6. 文件摘要改由上传器在第 6 节按文件顺序读取每个分块时增量计算，避免发送前完整读取一次、上传时再完整读取一次。

解析阶段尚未调用 Agent，所以 Web 页面不会显示“解析中”或“待传输”任务。

## 5. 协商与认证

出队时移动端将任务状态乐观更新为 `negotiating`，随后执行：

```text
POST http://<Agent IP>:<controlPort>/v1/transfers
```

请求包含：

- `transferId`、`sourceDeviceId`、项目清单和字节数。`v2` 的文件项目不携带完整 SHA-256；文字仍在清单中携带摘要。
- `chunkSizeBytes`：新任务为 1 MiB。
- HMAC-SHA-256 认证头：签名覆盖 HTTP 方法、路径、时间戳、nonce 与请求体 SHA-256。

Agent 校验可信设备、接收许可、HMAC、时间窗口与 nonce 重放后，在 SQLite 创建或返回同一 `transferId` 的任务。创建响应包含：

- Agent 实际采用的 `chunkSizeBytes`。
- 每个项目的 `receivedBytes`。
- 每个项目已持久化的 `receivedChunkIndexes`。

移动端必须使用响应中的分块大小和已确认索引，而不是假设当前版本常量。这样旧 1 MiB 任务在新客户端上仍能续传。

协商请求的超时为 15 秒。应用层用 Promise 竞速保证即使原生 `fetch` 没有及时响应取消信号，队列也会从等待中释放并转为 `waiting_for_peer`。可恢复的网络失败会自动以 5、10、20 秒退避重试三次；每次均重新协商，以 Agent 的已确认分块索引为准。三次仍失败时保留“等待对端”并显示图标重试入口。

## 6. 分块上传与窗口控制

协商成功后，移动端确认暂存文件仍存在且文件大小未变化。上传器按文件顺序读取所有分块，已确认的断点分块只参与本地摘要计算而不重复发送，因此恢复时仍只需一次文件读取。

每个缺失分块使用：

```text
PUT /v1/transfers/:transferId/items/:itemId/chunks/:chunkIndex
Content-Range: bytes <start>-<end>/<total>
X-FlowDrop-Chunk-Sha256: <chunk digest>
```

发送器对新 1 MiB 任务维护最多 4 个在途 PUT 请求；已存在的 4 MiB 任务退化为单请求，以避免重新产生高内存窗口：

1. 读取一个尚未确认的分块，计算块摘要并发出 PUT。
2. 窗口未满时继续提交后续分块，不等待前一块 HTTP 响应。
3. Agent 确认块已持久化后，移动端才将该块字节计入上传进度。
4. 任一请求失败后，发送器停止补充窗口并以失败码更新任务。
5. 任务恢复时，移动端按 Agent 返回的已确认索引跳过已落盘分块，只补发缺块，但仍读取这些分块以产生同一份完整摘要。

创建响应返回后，发送器先把移动端任务切换为 `transferring` 并让出一帧，再开始同步读取、计算摘要和签名分块；每个分块投递后同样让出一帧。这避免 React Native 的连续 JS 二进制工作阻塞状态绘制和暂停/取消点击。分块响应中的 Agent `transferredBytes` 是移动端进度的权威值；传输中显示的 `B/s` 由相邻确认样本计算，仅表示确认速率，不写入历史记录。

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

`v2` 完成请求包含每个文件的最终 SHA-256。Agent 检查每个项目已收字节数与声明大小一致，再计算 `.part` 文件的完整 SHA-256 并比对。成功后将文件原子移动到 `incoming`，更新项目与任务为 `completed`，并发布 SSE。只有收到该完成响应，移动端才把自己的任务标记为 `completed`。应用重新进入传输页时会查询尚未终态的远端任务：若 Agent 已完成则直接补写本地 `completed`，避免完成响应丢失后重复发送；其它远端进行中状态会恢复为本地 `paused`，要求用户显式继续。

## 8. 暂停、继续与取消

暂停、继续、取消使用已认证的 `/pause`、`/resume`、`/cancel` 接口。移动端先乐观写 SQLite 和 UI，再等待 Agent 响应：

- Agent 成功：两端持久化相同状态，Web 通过 SSE 刷新。
- Agent 返回 `TRANSFER_NOT_FOUND`：视为接收端从未收到该任务的极端情况，保留本地乐观状态；继续会重新创建接收任务。
- 其它错误：移动端回滚到可继续状态并显示错误。

Agent 在暂停或终态后拒绝迟到的分块和完成请求，避免并发请求把任务状态重新写回 `transferring`。

## 9. 已验证与未验证

已通过静态检查：移动端 TypeScript、Windows Agent TypeScript、差异空白检查。

尚未完成或尚未验证：

- `v2` 的移动端到 Agent 端到端吞吐、暂停、恢复、取消、自动重试和完成响应丢失后的状态对账。
- Agent 进程必须重启，移动端必须重新构建安装；旧 Agent 不理解 `v2` 创建请求，无法接收新文件任务。
- 文件内容仍经明文 HTTP 传输；HMAC 不提供内容机密性，也不能防御不安全初次配对中的中间人。
- 没有带宽自适应、后台持续传输、过期暂存清理或 Agent -> mobile 文件接收。
