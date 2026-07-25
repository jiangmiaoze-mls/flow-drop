import {execSync} from 'node:child_process'


const aliases: Record<string, string> = {
  mobile: 'mobile-rn',
  web: 'local-web',
  agent: 'windows-agent'
}

const project = process.argv[2]
const filter = project ? aliases[project] ?? project : null

execSync(
  filter
    ? `pnpm --filter ${filter} exec tsc --noEmit`
    : `pnpm -r exec tsc --noEmit`,
  {stdio: 'inherit'}
)