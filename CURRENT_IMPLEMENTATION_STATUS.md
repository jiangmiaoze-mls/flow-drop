# FlowDrop 当前实现状态

更新时间：2026-07-26

本文根据当前工作区代码与本窗口已完成的验证整理。`已实现`仅表示代码已存在；除非明确写有验证，不代表已经在真实 Android/iOS 设备或完整局域网流程中验收。

## 1. 当前目标与边界

FlowDrop 由三个主要端组成：

- `apps/mobile-rn`：Android/iOS 移动端，负责局域网发现、双向配对、可信设备管理和后续发送/接收内容。
- `apps/windows-agent`：Windows Agent，负责局域网发现、可信设备持久化、配对控制端点和本机管理服务。
- `apps/local-web`：由 Agent 本机管理服务托管的 Web 管理界面，当前为最简可操作页面。

当前 MVP 的正确边界应是：前台局域网发现、双向人工确认配对、双方持久化可信设备、真实的文件/文字传输。现有代码尚未完成最后一项。

## 2. 已实现功能

### 2.1 Monorepo 公共包

| 包 | 已实现内容 |
| --- | --- |
| `@flowdrop/config` | 集中配置 `DISCOVERY_PORT=17654`、`DISCOVERY_BROADCAST_ADDRESS`、`PAIRING_CONTROL_PORT=3000`、`AGENT_ADMIN_PORT=3001`。 |
| `@flowdrop/types` | 发现、可信设备、配对会话、配对审批、WebSocket 对等消息、传输准入等共享类型。 |
| `@flowdrop/network` | Windows 端 IPv4 网卡定向广播地址计算；Android 端 Wi-Fi IPv4/子网掩码/广播地址原生查询模块。 |

### 2.2 局域网发现

- 移动端使用 `react-native-udp` 绑定 UDP `17654`，周期性发送发现公告并维护设备 TTL。
- Windows Agent 使用 Node `dgram` 在各 IPv4 网卡的定向广播地址发送公告，并接收移动端与其他 Agent 的公告。
- 发现消息包含协议版本、稳定设备 ID、设备名称和配对控制端口。
- Agent 已包含收到公告后的单播回应逻辑；但当前 `pairingAvailable` 判断条件与公告值相反，移动端正常公告不会触发该回应，尚未达到降低广播依赖的目标。
- 移动端发现页已使用实际发现结果，而非首页模拟设备数据。
- Android 发现流程会请求定位权限；应用 Manifest 配置了 Wi-Fi 与 UDP 广播相关权限。

### 2.3 设备 ID 与设备信息

- Android：`expo-application` 的 `androidId` 作为设备 ID。
- iOS：`expo-crypto` 生成 UUID，并通过 `expo-secure-store` 持久化。
- Windows Agent：`node-machine-id` 返回的机器 ID 哈希作为设备 ID。
- 移动端设备管理页“我的设备”会显示设备名称、设备 ID、本机 Wi-Fi IPv4、一次性配对码。

### 2.4 双向配对

#### 移动端发起，Agent 接收

1. Agent 本机管理页面生成两分钟有效的六位配对码。
2. 移动端选择 Agent、输入配对码后，通过 `ws://<agent-ip>:3000/v1/peer` 发送 `peer.hello` 与 `pairing.request`。
3. Agent 本机 Web 页面通过 SSE 收到请求，用户可接受或拒绝。
4. 结果经 WebSocket 回传移动端；接受时双方保存可信设备。

#### Agent 发起，移动端接收

1. 移动端根布局在应用前台启动 TCP/WebSocket 配对端点，监听 `3000/v1/peer`。
2. 移动端设备管理页创建和展示一次性、两分钟有效的六位配对码，可手动刷新。
3. Agent 本机 Web 的局域网设备表可输入该配对码，Agent 通过 WebSocket 主动请求手机配对。
4. 手机显示接受/拒绝对话框；接受时向 Agent 返回 `pairing.resolved`，双方保存可信设备。

配对会话是一次性凭证，成功验证后即失效；审批请求默认 60 秒过期。

### 2.5 可信设备持久化与权限

- 移动端通过 `expo-sqlite` 保存可信设备：名称、类型、上次地址、控制端口、配对时间、接收传输开关等。
- Agent 通过 `TrustedDeviceStore` 保存等价的可信设备信息。
- 移动端设备管理页渲染真实可信设备列表，并可切换“允许接收传输”。
- Agent 本机 Web 管理页也可切换每台可信设备的接收许可。
- 当前设计中，解除信任不自动让另一端解除信任；传输时由接收端拒绝并返回可解释错误。这避免了单边删除导致的错误同步假设。

### 2.6 Agent 本机管理服务与 local-web

- Agent 业务服务监听 `0.0.0.0:3000`。
- Agent 管理服务监听 `127.0.0.1:3001`，仅允许回环访问。
- 管理接口提供发现设备、可信设备、创建配对码、审批请求、接收许可修改、解除信任和 Agent 事件流。解除信任只删除当前设备本地的配对记录和传输凭据，不会远程删除对端记录；双方都应解除信任后再重新配对。
- `apps/local-web` 使用 SSE (`/api/admin/events`) 同步设备、配对状态和本机文件演示列表，不再使用周期轮询。
- local-web 当前仍是功能验证用的简化页面；Agent 主动配对手机的输入码入口使用浏览器 `prompt`，需要在正式 UI 阶段替换。
- local-web 已提供本机文件演示：可将不大于 32 MiB 的文件导入为“已接收”并落盘到 `%LOCALAPPDATA%/FlowDrop/local-web-demo/incoming`，也可创建持久化的“等待对端”发送队列并暂存到 `outgoing`。该发送队列不会伪装成已发送：移动端接收服务和 Agent -> mobile 的文件协议尚未实现。

### 2.7 传输准入

- 移动端进入传输页前会向目标 Agent 调用 `/api/transfers/admission`。
- Agent 会检查来源设备是否已配对、是否被允许向该 Agent 发送内容。
- 传输准入失败会在移动端以 `BasicAlertDialog` 显示错误。
- 已开始实现 Agent 端的传输接收基础设施：共享 `TransferTask` / `TransferItem` 模型、SQLite 任务与分块记录、`staging` / `incoming` 目录、固定 4 MiB 分块、块与整文件 SHA-256 校验、幂等块写入、原子提交、状态查询和取消端点（`/v1/transfers`）。该端点已接入移动端发送队列，并由配对凭据 HMAC 认证；没有有效凭据的请求返回 `AUTHENTICATION_REQUIRED`。
- 本机 Web 文件演示不复用对等传输 API，也不绕过其认证限制；它只用于验证 Agent 本机管理页面的文件选择、持久化与状态列表交互。

## 3. 已知未完成项

### P0：真实内容传输

移动端已开始接入 Agent 接收端，但尚未形成可验收的安全传输：

完整的选择、解析、协商、上传、校验、完成与恢复链路见 [FILE_TRANSFER_PIPELINE.md](FILE_TRANSFER_PIPELINE.md)。

- 传输页已移除演示队列和演示进度，改为读取按目标设备持久化在移动端 SQLite 的发送任务。
- 移动端“传输记录”页已移除虚构设备、文件、时间和路径，改为从 SQLite 读取全部真实发送任务；按时间与按设备两个视图均由任务更新时间和已配对设备名称生成，并支持下拉刷新重新读取 SQLite。记录状态直接显示任务的 `preparing`、`queued`、`waiting_for_peer`、`transferring`、`completed`、`failed`、`cancelled` 等真实状态。移动端当前尚未实现接收端与接收记录持久化，因此该页不会伪造接收记录。
- 文字会创建单项任务、以 UTF-8 计算 SHA-256、创建 Agent 任务并请求完成；文件在选择后会立即以 `preparing`（界面显示“解析中”）状态写入 SQLite 队列。`DocumentPicker` 已先将选中文件复制进应用缓存，准备流程将该缓存文件移动到应用文档目录下的 `flowdrop-outgoing`，避免对大文件做第二次复制。Android development build 中，文件 SHA-256 改由现有 `@flowdrop/network` 原生模块的 `MessageDigest` 在 I/O 协程中流式计算，不占用 JS 线程；每达到 4 MiB 才向 JS 发一次进度事件并写入 SQLite。模块不可用时（例如旧开发包或 Web）才回退到 JS 的 256 KiB 分段实现。完成后原子替换为 `queued`（“待传输”）任务。解析任务会将文件总字节数和已哈希字节数同步写入 SQLite，发送页的现有进度条因而显示真实解析进度；DocumentPicker 提供文件大小时，会在选择后立即显示总进度。发送前不再完整重复哈希私有暂存文件，只检查文件存在和大小后即开始上传；Agent 仍以创建时声明的完整 SHA-256 校验收件内容。文件创建必须保留 `preparing` 状态；占位任务以全零 SHA-256 标识，不能以文件大小判断，否则已获得文件总大小的占位任务会被错误跳过并永久停留“待传输”。页面加载时会识别已有的全零摘要文件占位任务并恢复为 `preparing`，避免用户必须重新选择。解析中任务在应用重启后会尝试恢复解析，缓存源文件失效则标记失败。此前遗漏 `await` 会在副本尚未落盘时读取它，导致错误提示“文件在准备或传输期间发生变化”；该竞态已修正，尚未实机复测。
- 发送器会在 Agent 接收任务创建响应前显示 `negotiating`（“正在协商”），只有开始收到分块确认后才显示 `transferring`。传输没有按秒限速器，但当前采用单请求停等上传：每个 4 MiB 块必须收到 Agent 持久化响应后才发送下一块。将块从 1 MiB 提升至 4 MiB 后，可减少四倍 HTTP 往返、HMAC 与 SQLite 写入次数，代价是单请求峰值内存增加约 3 MiB；它不能消除真实网络、Agent 处理或磁盘导致的慢协商。每个 Agent 请求设有 15 秒超时，无法建立或在时限内完成响应的请求会将任务保留为 `waiting_for_peer`，避免界面无限停留在“传输中”。超时不只依赖 `AbortController`：发送协程以超时 Promise 竞速，因此即使某个真机原生 `fetch` 没有因取消信号及时拒绝，队列仍会释放并更新 SQLite 状态。当前没有自动重试、暂存文件清理或历史保留策略；同一目标设备的当前页面队列已实现单任务 FIFO 调度，但尚无跨目标设备的全局调度。
- 多选文件时，移动端会先按选择顺序创建全部 SQLite 任务并显示为“解析中”，完成后台解析后变为“待传输”，然后 FIFO 逐项发送；队首成功后自动发送下一项。队首失败、暂停或等待对端时，后续任务保持待传输，不会绕过队首并发发送。
- 发送页不显示已完成或已取消任务，但两者都保留在 SQLite 历史中。失败任务提供“重发”；发送中任务同时提供暂停和取消，暂停后提供继续和取消，按钮只保留图标及无障碍标签。暂停、继续和取消先乐观写入移动端 SQLite 并立即刷新 UI，再调用 Agent 已认证的 `/pause`、`/resume`、`/cancel` 接口；Agent 会持久化对应状态并发布 `transfer.changed` 供本机 Web 刷新。远端操作失败时，移动端会回滚到可继续的本地状态并显示错误；仅 Agent 明确返回 `TRANSFER_NOT_FOUND`（接收端从未创建该任务）时保留本地乐观状态。暂停不会删除 Agent 暂存块；取消会清理 Agent 暂存块。应用重启后发现没有本地活动控制器的 `transferring` / `verifying` 等状态会恢复为 `paused`。发送器使用最多 4 个在途分块的滑动窗口，而不是逐块等待确认；Agent 将任务分块大小和已确认块索引持久化并返回，因此恢复时可补发缺失块。旧 Agent 数据库任务迁移为 1 MiB，新建任务使用 4 MiB，移动端始终按 Agent 返回的该任务分块大小恢复。尚未实机验证暂停、取消、恢复和网络竞态行为。
- Agent 接收 API 额外校验 `Content-Range` 的总长度与声明项大小一致，避免错误范围写入。传输路由现在由配对凭据认证器保护，而不是仅接受声明式 `sourceDeviceId`。
- Agent 与移动端现已开始使用配对绑定的 256 位随机传输凭据：手机通过 SecureStore 保存凭据，Agent 保存到其 SQLite 数据库；创建、分块、完成和取消请求都携带 HMAC-SHA-256 签名，签名覆盖 HTTP 方法、路径、时间戳、一次性 nonce 与请求体 SHA-256。Agent 校验签名、60 秒时钟窗口和 nonce 重放后才进入传输服务，因此不再依赖 `FLOWDROP_EXPERIMENTAL_UNAUTHENTICATED_TRANSFERS`。旧配对没有凭据，升级后必须双方解除信任并重新配对。
- 移动端“已配对设备”和 Agent 本机 Web 的可信设备列表均提供“解除信任”。该操作会删除当前设备保存的配对记录及传输凭据，因而是旧配对迁移到带凭据通道的必要步骤；它不会修改对端，所以双方都应执行解除信任后再重新配对。
- 该认证实现的边界必须明确：凭据当前经已有的明文配对 WebSocket 传递，Agent SQLite 凭据当前没有 Windows DPAPI 等静态加密保护，文件仍通过明文 HTTP 传输。因此它能防止未持有已配对凭据的请求与简单重放，但不能抵抗能监听或篡改初次配对的攻击者，也不提供文件内容机密性。长期密钥、公钥绑定、经过认证的密钥协商和 AEAD 加密仍是传输安全完成的必要后续工作。
- Agent 会将成功接收的任务状态和被拒绝的传输请求发布到 SSE；local-web 新增“来自局域网设备的传输”列表和拒绝原因提示。若移动端任务显示 `waiting_for_peer`，表示其 HTTP 请求没有抵达 Agent 的 `3000` 端口，管理页不会有传输事件；此时应检查发现记录中的 IP/端口和 Windows 防火墙。若请求抵达但尚未完成认证，管理页会显示 `AUTHENTICATION_REQUIRED` 拒绝提示。
- 移动端创建传输请求现显式发送 `Content-Type: application/json`。此前遗漏该请求头会导致 Fastify 不能把 `POST /v1/transfers` 请求体作为 JSON 协议清单解析。未签名请求应返回 `HTTP 401 {"code":"AUTHENTICATION_REQUIRED"}`，并且不会创建任务或写入文件。这只能证明 Agent 监听与路由可用，不能证明手机到电脑的 HTTP 连通性。
- 工作区当前的锁文件与移动端 `node_modules` 中已存在 `@noble/hashes@2.2.0`，所以发送器可以引用其审计过的增量 SHA-256 实现；本次未执行依赖安装命令。尚未在 Android/iOS 实机验证该包的 Metro 打包、文件复制、二进制 `fetch` 请求体或内存占用。

### P0：移动端生命周期警告

已修复已定位的异步卸载更新窗口：配对底部面板在配对成功后导航离开时，其异步提交 `finally` 仍可能执行 `setIsSubmitting(false)`；文字投递底部面板也曾在异步投递结束后无条件更新状态；相机授权和设置返回流程也可能在面板卸载后重新打开页面。现在这些回调在组件仍挂载时才更新 React state，挂载标志初始为 `false` 并只在 `useEffect` 后设为 `true`，避免首帧提交前的状态更新。传输页的异步准入检查同样增加了挂载保护。此修复已通过 TypeScript 静态检查，尚未在 Android/iOS 实机复现原始警告后验证消失。

后续应先定义传输协议：元数据协商、分块大小、SHA-256 校验、取消、断点续传、失败原因与磁盘清理策略。不要先把模拟 UI 改复杂。

#### 真实内容传输技术方案（进行中）

**V1 边界。** 首个可验收版本仅承诺同一局域网内、双方已配对、发送端与接收端应用均处于可用状态时的传输。移动端后台不能承诺持续收件：Android 需要后续前台服务，iOS 保持前台限制。应先完成 mobile -> Agent 的可靠传输；Agent -> mobile 需要把移动端现有 TCP 服务扩展为同时处理传输 HTTP 请求，且只在移动端前台监听后才能交付。

**统一数据模型。** 文件和文字均创建一条 `TransferTask`，并由一个或多个 `TransferItem` 组成，不能由页面直接发网络请求：

| 实体 | 必要字段 | 说明 |
| --- | --- | --- |
| `TransferTask` | `transferId`、协议版本、方向、目标 `deviceId`、创建/更新时间、优先级、状态、重试次数、失败码、总/已传字节 | 队列调度、恢复、取消和历史记录的最小单位；`transferId` 全局唯一且可幂等重试。 |
| `TransferItem` | `itemId`、类型（`file` / `text`）、显示名、MIME、字节数、SHA-256、已传字节、源暂存路径或 UTF-8 文本 | 一个任务可包含多个文件；文字是单个内联项，不另行设计第二套发送流程。 |
| 接收端记录 | 来源设备、任务/项 ID、临时路径、已收块、校验状态、最终落盘位置、过期时间 | 接收端先持久化记录和临时文件，校验通过后再原子移动到收件目录。 |

移动端出队前必须把 DocumentPicker 返回的文件复制到应用管理的暂存目录，并记录大小和 SHA-256；不得依赖可能失效的外部 `content://` URI，也不得把大文件转成 Base64。文字统一 UTF-8 编码，设定明确的最大大小（建议 V1 不超过 256 KiB），超限应在入队前拒绝。

**状态机与队列。** 现有 `success` / `interrupted` 记录类型不足以表达可恢复传输，任务状态应至少为：

```text
draft -> preparing -> queued -> waiting_for_peer -> negotiating -> transferring
      -> verifying -> completing -> completed
瞬时网络错误或用户暂停 -> paused / failed（可重试） -> queued
任何非终态 -> cancelled
```

- `waiting_for_peer` 是设备离线、移动端不在前台或网络暂不可用，不应直接标为失败。
- `failed` 必须保存稳定错误码与可否重试；`cancelled` 和 `completed` 为终态。应用重启后从 SQLite / Agent 数据库恢复非终态任务。
- 初始调度策略应为全局并发 2、同一目标设备并发 1；支持用户取消、暂停、继续和调整队列顺序。只有传输中的任务占用网络资源。
- 自动重试只用于超时、连接中断和短暂网络错误，并采用有上限的退避；未配对、接收关闭、认证失败、空间不足、文件已变更、校验失败和协议不兼容必须等待用户处理或明确重新发起。

**对等传输协议。** 保留配对 WebSocket 用于配对，不复用其文本帧传送文件。传输使用版本化的 HTTP 二进制端点，避免 WebSocket 大帧和把文件整体读入内存。建议的接收端端点为：

```text
POST /v1/transfers                         创建任务，提交元数据清单并检查身份、许可、磁盘空间和配额
PUT  /v1/transfers/:id/items/:itemId/chunks/:index
                                           上传固定大小二进制块，携带 Content-Range 与块 SHA-256
GET  /v1/transfers/:id                     查询状态、缺失块与可恢复偏移
POST /v1/transfers/:id/complete            请求最终校验并原子提交
POST /v1/transfers/:id/cancel              幂等取消并清理接收端临时数据
```

建议 V1 固定 1 MiB 块、单任务单文件顺序上传；大小必须由接收端协商/限制，而不是由发送端单方面决定。发送端先计算完整文件 SHA-256，接收端校验每块与完整文件 SHA-256。网络中断后，发送端查询接收端已持久化块并仅补传缺失部分；只有收到接收端持久化后的 `completed` 响应，发送端才能标记成功。所有创建、分块、完成与取消请求都必须按 `transferId` / `itemId` 幂等处理。

**接收、存储与清理。** Agent 应在 `%LOCALAPPDATA%/FlowDrop` 下使用独立的 `incoming`、`staging` 和数据库目录；移动端使用应用文档目录与临时目录。文件名需净化，禁止路径穿越和覆盖现有文件；完成前写入 `.part` 文件，校验完成后原子重命名。接收端应保留最低可用磁盘空间、配置单任务/总队列大小上限，并在取消、失败或超时后清理临时数据（默认清理周期需要在实现时确定）。传输历史仅保存必要元数据，文字内容与文件路径的保存期限需要产品明确。

**权限与安全。** 当前仅凭请求体中的 `sourceDeviceId` 做准入，不能作为真实内容传输的身份认证。传输实现前必须完成长期密钥对、配对时公钥绑定、签名挑战和加密数据通道；不得自行实现密码学。接收端需要在创建、恢复和完成阶段重新检查可信关系与 `receiveEnabled`，以处理配对删除或权限在传输中被关闭的情况。

**实现前验证。** 先做两个最小技术验证，不要直接改造 UI：

1. 验证 Expo/RN 当前版本能以受限内存从本地文件读取二进制块并以 HTTP 请求体发送，不经 Base64；若不能，先选定兼容的原生流式实现方案。
2. 用 Agent 端实现一个临时的单文件 1 MiB 分块接收、断线续传、完整 SHA-256 校验和原子落盘闭环，再接入持久化队列与移动端 UI。

完成上述闭环后，再扩展文字、多文件任务、Agent -> mobile 接收端、限速、队列控制、历史界面和后台策略。任何传输 UI 只能反映持久化任务状态，不能再使用演示进度或演示队列。

**当前实现边界。** 已检查当前工作区安装的 Expo SDK 57 类型：`expo-file-system` 提供 `FileHandle.readBytes`，可按块读取文件；`expo-crypto` 只有对完整 `BufferSource` 的一次性 `digest`，因此移动端发送器使用工作区已解析的、审计过的 `@noble/hashes@2.2.0` 增量 SHA-256 实现，未自行实现密码学。当前传输 API 已有配对凭据 HMAC 认证，但尚未完成长期密钥、公钥绑定、经过认证的密钥协商与文件内容 AEAD 加密；在这些完成前，不能将其表述为抗中间人或保密的内容传输。

### P0：真实设备联调与原生构建

- `FlowDropNetworkModule.kt` 已修改，增加 `LinkProperties` 回退以处理 `WifiManager.dhcpInfo` 为空的热点/VPN 场景。
- 此修改属于 Android 原生模块变更，当前已安装 dev client 不会自动包含它，必须重新构建 development build 或 EAS 包并安装后验证。
- 当前 ADB 查询到的安装包权限中未出现新加入模块 Manifest 的 `ACCESS_NETWORK_STATE`，说明该安装包不是包含最新原生修改的新构建。
- 未完成真实设备上的以下验证：热点、普通路由器 Wi-Fi、VPN 开启、VPN 关闭、屏幕熄灭/切后台、多个 Agent、多部手机。

### P0：Android UDP 接收稳定性

- Manifest 已声明 `CHANGE_WIFI_MULTICAST_STATE`，但当前没有申请 `WifiManager.MulticastLock`。
- 在部分 Android ROM 上，没有持有该锁时可能丢弃 UDP 广播/组播接收包，影响发现稳定性。
- 建议扩展现有 `@flowdrop/network` Android 原生模块，提供显式获取/释放 MulticastLock 的接口，并仅在发现服务运行期间持有。

### P1：移动端接收端生命周期

- 移动端 WebSocket 配对服务仅在应用进程存活且前台时可靠。
- Android 后台持续接收需原生前台服务和常驻通知；普通 Expo 后台任务不能可靠维持 TCP/WebSocket 监听。
- iOS 不允许用普通后台任务长期监听局域网端口，不能承诺后台被 Agent 主动配对或收文件。
- MVP 应明确标注“打开应用后可被发现和接收配对”，不要伪装为后台常驻能力。

### P1：配对协议安全增强

当前配对控制面不是端到端安全协议：

- 使用明文 `ws://` 和 `http://`，局域网内可被被动监听或中间人篡改。
- `deviceId` 只是声明值，尚未使用设备私钥签名或证书证明身份。
- 六位码作为会话秘密可降低误配，但不足以建立长期强身份。

后续在传输实现前，应为每台设备生成并安全保存长期密钥对，配对时交换公钥并将配对码绑定到双方会话挑战；之后使用签名的握手和加密数据通道。

### P1：平台覆盖

- `@flowdrop/network/mobile` 的原生 Wi-Fi 子网/广播查询目前只实现 Android。
- iOS 设备管理页不会得到该原生 Wi-Fi IPv4 信息；iOS 本地网络权限描述已配置，但未完成 iOS 原生网络信息与入站 TCP 端到端验证。
- `expo-network` 已被加入移动端依赖，但按当前决定未用于 IP 展示；不要在未决定用途前让它成为第二套 IP 数据源。

### P2：管理界面与体验

- local-web 是演示页面，缺少正式的表单、错误状态、设备类型识别、配对进度、会话倒计时和可访问性完善。
- Agent 发现协议没有明确携带设备种类，local-web 无法可靠判断“输入手机配对码”按钮是否应该出现。
- 移动端发现页当前将所有发现设备固定映射为 `desktop`；在协议携带 `deviceKind` 前，不能可靠区分 Agent、手机或未来其他端。
- 移动端“我的设备”配对码没有自动倒计时刷新显示；过期后应自动生成新会话或明确提示已过期。
- 可信设备缺少别名、手动删除、详情、最后在线状态与审计记录。

## 4. 当前已知问题与诊断结论

### 本机 IP 获取

已在设备侧验证：移动端“我的设备”可以正常获取本机 IP。该地址仍由 `getWifiIPv4BroadcastTargetAsync()` 提供，用于展示 Wi-Fi IPv4，并为 Android 定向广播提供子网信息。

需要保留的诊断原则：如果后续该接口返回 `null`，优先检查当前安装包是否包含最新原生模块、是否存在活动 Wi-Fi、以及系统是否提供 DHCP/`LinkProperties` IPv4 信息；不要把 Agent 收到的 UDP 源地址与 App 内原生模块的返回值混为同一条调用链。

### VPN 对局域网发现的影响

已确认：手机开启 VPN 时曾导致双方只能收到自己的广播或无法互相发现。VPN 可能接管默认路由、改变活动网络或限制本地网络流量。当前没有 VPN 绕过或网络绑定策略；应列为后续兼容性工作，而不是承诺“任意 VPN 下正常发现”。

### 发现兜底单播条件错误

已通过代码检查确认：Agent 发送的公告始终包含 `pairingAvailable: true`，但收到公告后的单播回应条件为 `!announcement.pairingAvailable`。因此移动端正常公告不会触发预期的单播回应，文档此前“Agent 会发一次单播回应”的描述不成立。应在实机联调前修正条件，并为该行为增加自动化测试。

### Agent 管理界面构建链路缺失

`apps/local-web` 的 Vite 构建输出目标为 `apps/windows-agent/public`，但当前该目录没有 `index.html`，且 `agent:start` / `agent:dev` 不会先执行 local-web 构建。因此从干净工作区仅启动 Agent 时，本机管理 API 可以启动，但无法保证管理页面可用。需要增加统一构建脚本、启动前检查，或在交付步骤中明确先构建 local-web。

### 移动端 SDK 状态与文档不一致

`apps/mobile-rn/package.json` 已加入 `expo-sharing`、`expo-media-library` 和 `expo-clipboard`，但当前业务代码未使用它们；这与“建议但暂不引入”的表述不一致。后续应在真实接收落盘、相册保存或复制功能实施时再使用这些 SDK，或移除未使用依赖并同步锁文件。

### 原生模块修改的交付规则

以后以下变更都必须在交付说明中明确写“需要重新 build”：

- Android/iOS 原生代码、原生模块 Manifest、Gradle/Pod 配置。
- 新增或升级需要原生链接的 Expo/RN SDK。
- `app.json` 中影响原生权限、插件、Info.plist 或 Android Manifest 的配置。

Metro 热更新只更新 JavaScript，不能更新已安装 dev client 内的原生二进制。

## 5. 已执行验证

已通过直接调用项目现有 TypeScript 二进制的类型检查：

```text
apps/mobile-rn: tsc --noEmit -p apps/mobile-rn/tsconfig.json
apps/windows-agent: tsc --noEmit -p apps/windows-agent/tsconfig.json
apps/local-web: tsc --noEmit -p apps/local-web/tsconfig.app.json
```

已执行 `git diff --check`，未发现空白字符错误。

传输接收端改动已使用 Agent 项目自身的 TypeScript 二进制执行 `tsc -p apps/windows-agent/tsconfig.json --noEmit`，通过。新增 `@noble/hashes@2.2.0` 声明后，工作区 `pnpm typecheck` 会先要求同步依赖和锁文件；因项目约束未执行安装，非交互环境下该命令已中止于 pnpm 的依赖同步确认，完整工作区类型检查需在用户安装依赖后重跑。

本次修改已执行：`apps/windows-agent` TypeScript 检查、`apps/mobile-rn` TypeScript 检查，以及 local-web 使用其项目内 TypeScript 6 的检查，均通过。工作区根 TypeScript 无法识别 local-web 已有的 `erasableSyntaxOnly` 配置，不能替代该项目内检查。

本次开始实现移动端发送器后，已再次执行 `apps/windows-agent`、`apps/mobile-rn` 与 `apps/local-web` 各自项目内的 TypeScript 静态检查，以及 `git diff --check`，均通过。未执行 Agent 进程运行时验证或移动端实机传输测试，以避免在用户机器上启用实验性未认证端点或留下测试收件文件。

本次也已执行 local-web 生产构建，并输出到 `apps/windows-agent/public`；Agent TypeScript 编译通过。运行中的 Agent 进程需要重启才能加载新增传输 API、SSE 事件和静态管理页面。

配对凭据与 HMAC 认证改动已使用移动端和 Agent 各自 TypeScript 二进制检查通过，并重新执行 Agent TypeScript 编译。未做手机到电脑实机传输验证；本机运行中的旧 Agent 进程尚未由本次修改自动重启。

本次补充的双方“解除信任”入口已通过移动端 TypeScript 检查、local-web 生产构建和 Agent TypeScript 编译；未对运行中的 Agent 管理服务或 Android/iOS 真机执行点击与持久化删除验证。运行中的 Agent 必须重启后才会加载删除接口和新管理页面。

本次传输记录数据源替换与下拉刷新已通过移动端 TypeScript 静态检查和 `git diff --check`；尚未在真机上创建任务并验证记录页刷新、搜索、筛选与详情展示。

本次发送队列的完成/取消隐藏、失败重发、暂停、继续和取消已通过移动端与 Agent TypeScript 静态检查及 `git diff --check`；未在真机与 Agent 之间验证重发、暂停时的请求终止、取消端点、Agent 已确认字节偏移、断点续传及网络竞态。

本次多选文件 FIFO 队列已通过移动端 TypeScript 静态检查和 `git diff --check`；未在真机选择多个文件验证显示顺序、失败阻塞、暂停后继续与逐项发送。

本次文件选择的立即入队、解析中占位、后台哈希让出 UI 与解析恢复已通过移动端 TypeScript 静态检查和 `git diff --check`；未在真机以大文件验证实际首帧渲染、滚动流畅度、应用重启后的缓存 URI 可用性与解析恢复。

当前未发现项目自动化测试文件；`apps/windows-agent` 的 `test` 脚本引用不存在的 `test/tsconfig.json`。现有类型检查只能验证 TypeScript 静态一致性，不能验证 UDP 发现、SSE、WebSocket 配对、SQLite 持久化或原生网络行为。

local-web 已完成生产构建；也已通过 Vite 开发服务确认本机文件演示、设备列表和配对入口可渲染，浏览器控制台未发现页面错误。未执行实际文件导入/暂存 API 的端到端写入验证，避免在用户机器上留下测试文件。

未执行或未完成：Android Gradle 编译、新 development build/EAS 构建、iOS 构建、完整 Agent-手机双向实机配对、Agent 传输 API 的运行时/集成验证、移动端发送器的实机文件/文字传输、自动或手动重试、远端取消和 Agent 从干净工作区启动时的 local-web 自动构建/托管验证。

## 6. 推荐后续整合顺序

1. 修正 Agent 收到移动端公告后的单播回应条件；为发现协议补充 `deviceKind`，并统一 Agent、mobile、local-web 的设备模型。
2. 补齐 local-web 到 Agent `public` 目录的构建/启动链路，验证从干净工作区启动时管理页面可用。
3. 重新构建并安装 Android development build，验证 `FlowDropNetwork` 模块、IP 展示、定向广播与双向配对。
4. 为 Android 发现服务加入并验证 `WifiManager.MulticastLock`。
5. 完成正式配对 UI：Agent 侧替换 `prompt`，移动端配对码增加倒计时、刷新与端点启动失败提示。
6. 在重新构建的 Android development build 上验证 `@noble/hashes`、受限内存的文件暂存、完整哈希和 HTTP 二进制分块发送。
7. 完成 Agent 接收 API 的运行时验证后，补齐移动端任务恢复、重试、远端取消、队列并发控制与暂存清理。
8. 增加密钥对、签名握手和加密传输，降低局域网中间人风险，并为发现、配对、传输和持久化补充自动化测试。
9. 根据产品要求决定后台策略：仅前台，或 Android 前台服务；iOS 保持前台限制并在 UI 中说明。

## 7. 建议但暂不引入的移动端 SDK

注意：以下建议表达的是功能使用时机；`expo-sharing`、`expo-media-library` 和 `expo-clipboard` 当前已在 `apps/mobile-rn/package.json` 中，尚未被业务代码使用，详见“移动端 SDK 状态与文档不一致”。

| 优先级 | 能力 | 建议 |
| --- | --- | --- |
| P1 | 接收文件后的系统打开/分享 | 真实接收落盘后再引入 `expo-sharing`。 |
| P1 | 接收图片/视频自动保存相册 | 只有产品明确需要自动入相册时引入 `expo-media-library`。 |
| P2 | 文本一键复制 | 可引入 `expo-clipboard`，但不阻塞传输 MVP。 |
| 不建议当前引入 | `expo-background-task` / `expo-background-fetch` | 无法可靠维持 TCP/WebSocket 服务端，不解决后台接收问题。 |
| 不建议当前引入 | 推送 SDK | 没有云端推送通道，且不解决局域网后台监听。 |

## 8. 用户明确约束

以下规则来自当前项目协作过程，后续实现必须遵守：

1. **原生改动必须提醒重新构建。** 修改 Android/iOS 原生代码、原生模块、原生依赖、权限、插件或原生构建配置后，最终交付说明必须明确写出“需要重新 build”。
2. **不得自行执行依赖安装。** 如需新依赖，只修改对应 `package.json`；由用户自行执行安装命令。
3. **双方都必须能发起和接收配对。** Agent 与 mobile 均需要发现对方、发起配对、接收配对请求、接受或拒绝，并分别持久化可信设备。
4. **可信设备必须本地持久化。** 配对成功后，双方保存设备 ID、名称、类型、地址、控制端口、配对时间及接收许可；单方解除信任不自动删除另一方记录，实际传输时由接收端返回拒绝原因。
5. **移动端设备 ID 的来源固定。** Android 使用 `Application.androidId`；iOS 使用 `expo-crypto` 生成随机 ID，并通过 `expo-secure-store` 持久化；Windows Agent 使用 `node-machine-id`。
6. **发现使用定向广播。** 热点/局域网网卡的 IP 与定向广播地址归入 `packages/network`；Agent 与移动端均使用该模型，不能退回只依赖全局 `255.255.255.255`。
7. **移动端错误提示使用 `BasicAlertDialog`。** local-web 当前可保持最简演示页面，后续再完善正式 UI。
8. **不得用模拟数据伪装为完成。** 首页设备列表、可信设备列表和配对状态应绑定真实数据源；传输页面现有模拟内容必须在真实传输实现时替换。
9. **修改与方案必须同步状态文档。** 对项目做任何代码、配置、依赖或文档修改，或出具会影响实施判断的方案后，都必须同步更新 `CURRENT_IMPLEMENTATION_STATUS.md`，明确已验证事实、未验证项、风险与下一步。
