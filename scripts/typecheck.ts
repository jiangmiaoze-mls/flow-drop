import { execSync } from 'node:child_process';

const aliases: Record<string, string> = {
  mobile: 'mobile-rn',
  web: 'local-web',
  agent: 'windows-agent'
};

const project = process.argv[2];
const filter = project ? aliases[project] ?? project : null;

const cmd = (workspace: string) =>
  `npm exec --workspace=${workspace} -- tsc --noEmit`;

if (filter) {
  execSync(cmd(filter), { stdio: 'inherit' });
} else {
  // 需要获取所有工作区列表，可以用 `npm ls --workspaces --json`，但更简单的是直接遍历已知列表
  const workspaces = ['mobile-rn', 'local-web', 'windows-agent'];
  for (const ws of workspaces) {
    execSync(cmd(ws), { stdio: 'inherit' });
  }
}