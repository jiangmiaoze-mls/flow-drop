declare module 'react-native-udp' {
  export type RemoteInfo = {
    address: string
    family: 'IPv4' | 'IPv6'
    port: number
    size: number
  }

  export type SocketOptions = {
    debug?: boolean
    reusePort?: boolean
    type: 'udp4' | 'udp6'
  }

  export interface Socket {
    bind(port: number, address?: string, callback?: () => void): void
    close(callback?: () => void): void
    on(event: 'error', listener: (error: Error) => void): this
    on(
      event: 'message',
      listener: (message: {length: number; toString: (encoding?: string) => string}, remote: RemoteInfo) => void,
    ): this
    once(event: 'error', listener: (error: Error) => void): this
    once(event: 'listening', listener: () => void): this
    removeListener(event: 'error' | 'listening' | 'message', listener: Function): this
    send(
      message: string,
      offset: undefined,
      length: undefined,
      port: number,
      address: string,
      callback?: (error?: Error) => void,
    ): void
    setBroadcast(enabled: boolean): void
  }

  type Udp = {
    createSocket(options: SocketOptions): Socket
  }

  const dgram: Udp
  export default dgram
}
