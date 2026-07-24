export type Device = {
  id: string
  ip: string
  name: string
  type: 'desktop' | 'laptop'
  authorized?: boolean
}