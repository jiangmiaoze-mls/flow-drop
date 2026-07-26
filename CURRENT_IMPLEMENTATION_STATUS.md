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
- Agent 在接收到移动端公告后会发一次单播回应，降低只依赖广播导致的发现失败概率。
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
- 管理接口提供发现设备、可信设备、创建配对码、审批请求、接收许可修改和 Agent 事件流。
- `apps/local-web` 使用 SSE (`/api/admin/events`) 同步设备和配对状态，不再使用周期轮询。
- local-web 当前仍是功能验证用的简化页面；Agent 主动配对手机的输入码入口使用浏览器 `prompt`，需要在正式 UI 阶段替换。

### 2.7 传输准入

- 移动端进入传输页前会向目标 Agent 调用 `/api/transfers/admission`。
- Agent 会检查来源设备是否已配对、是否被允许向该 Agent 发送内容。
- 传输准入失败会在移动端以 `BasicAlertDialog` 显示错误。

## 3. 已知未完成项

### P0：真实内容传输

当前传输页仍包含演示数据和未实现循环：

- `expo-document-picker` 已可选择文件，但未读取文件内容、未上传、未分片、未计算校验和、未落盘。
- “投递文字”目前只执行目标端接收许可检查，未传送文本内容。
- 页面上的进度、速度、队列项目仍是模拟状态。
- Agent 没有文件上传、下载、缓存、限速、取消、重试、校验或传输记录 API。

后续应先定义传输协议：元数据协商、分块大小、SHA-256 校验、取消、断点续传、失败原因与磁盘清理策略。不要先把模拟 UI 改复杂。

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
- 移动端“我的设备”配对码没有自动倒计时刷新显示；过期后应自动生成新会话或明确提示已过期。
- 可信设备缺少别名、手动删除、详情、最后在线状态与审计记录。

## 4. 当前已知问题与诊断结论

### 本机 IP 获取

已在设备侧验证：移动端“我的设备”可以正常获取本机 IP。该地址仍由 `getWifiIPv4BroadcastTargetAsync()` 提供，用于展示 Wi-Fi IPv4，并为 Android 定向广播提供子网信息。

需要保留的诊断原则：如果后续该接口返回 `null`，优先检查当前安装包是否包含最新原生模块、是否存在活动 Wi-Fi、以及系统是否提供 DHCP/`LinkProperties` IPv4 信息；不要把 Agent 收到的 UDP 源地址与 App 内原生模块的返回值混为同一条调用链。

### VPN 对局域网发现的影响

已确认：手机开启 VPN 时曾导致双方只能收到自己的广播或无法互相发现。VPN 可能接管默认路由、改变活动网络或限制本地网络流量。当前没有 VPN 绕过或网络绑定策略；应列为后续兼容性工作，而不是承诺“任意 VPN 下正常发现”。

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

未执行或未完成：Android Gradle 编译、新 development build/EAS 构建、iOS 构建、完整 Agent-手机双向实机配对、真实文件传输。

## 6. 推荐后续整合顺序

1. 重新构建并安装 Android development build，验证 `FlowDropNetwork` 模块、IP 展示、定向广播与双向配对。
2. 为 Android 发现服务加入并验证 `WifiManager.MulticastLock`。
3. 修正发现协议，明确公告 `deviceKind`；统一 Agent、mobile、local-web 的设备模型。
4. 完成正式配对 UI：Agent 侧替换 `prompt`，移动端配对码增加倒计时、刷新与端点启动失败提示。
5. 设计并实现真实传输协议与 Agent 文件服务，再替换移动端传输页模拟数据。
6. 增加密钥对、签名握手和加密传输，降低局域网中间人风险。
7. 根据产品要求决定后台策略：仅前台，或 Android 前台服务；iOS 保持前台限制并在 UI 中说明。

## 7. 建议但暂不引入的移动端 SDK

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
