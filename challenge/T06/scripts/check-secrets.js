'use strict';
// T06-C58 점검: Git에 올라간 파일과 Git 기록 전체에 비밀값 원문이 없는지 찾는다.
// 실행: node scripts/check-secrets.js   (저장소 안 어디서든)
const { execFileSync } = require('node:child_process');

const PATTERNS = [
  ['DB 접속 주소(비밀번호 포함)', /postgres(?:ql)?:\/\/[^\s:'"`/@]+:[^\s@'"`]+@[^\s'"`]+/i],
  ['개인 키', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['GitHub 토큰', /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['AWS 접근 키', /\bAKIA[0-9A-Z]{16}\b/],
  ['Render API 키', /\brnd_[A-Za-z0-9]{20,}\b/],
  ['일반 비밀값 대입', /\b(api[_-]?key|secret|password|passwd|token)\b\s*[=:]\s*['"][^'"\s]{12,}['"]/i],
];

// 검사 코드가 일부러 넣은 가짜 값은 제외한다.
const ALLOW = [/NotARealPassword-zz9/, /\$\{secret\}@/, /scripts\/check-secrets\.js/];

const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: top, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });

function scan(label, text) {
  const hits = [];
  text.split('\n').forEach((line, i) => {
    if (ALLOW.some((a) => a.test(line))) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${label}:${i + 1} ${name}`);
  });
  return hits;
}

const hits = [];
const files = git('ls-files', '-z').split('\0').filter(Boolean).filter((f) => !f.endsWith('check-secrets.js'));
for (const f of files) {
  let text;
  try { text = git('show', `HEAD:${f}`); } catch { continue; }
  hits.push(...scan(`HEAD ${f}`, text));
}
const history = git('log', '--all', '-p', '--no-color', '--', '.', ':(exclude)*check-secrets.js');
hits.push(...scan('git log -p', history).map((h) => h.replace(/:(\d+) /, ' 줄 $1 ')));

console.log(`검사한 파일 ${files.length}개, Git 기록 ${git('rev-list', '--all', '--count').trim()}개 커밋`);
if (hits.length) {
  console.log('비밀값으로 보이는 글자 발견:');
  for (const h of hits) console.log('  ' + h);
  process.exit(1);
}
console.log('비밀값 원문 없음');
