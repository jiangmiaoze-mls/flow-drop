# TODO

- Bind Android discovery UDP sockets to the active Wi-Fi `Network` using `Network.bindSocket()` so local discovery remains available while a VPN is enabled. This requires extending or replacing the Android implementation of `react-native-udp` and rebuilding the Expo dev-client.
