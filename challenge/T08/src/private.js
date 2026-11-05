'use strict';
// 나만 보는 자리의 항목. 모든 문장은 user_id = 세션에서 찾은 사람 조건을 단다.
// 주소·본문에 다른 계정(user_id, username 등)을 적어 보내도 읽지 않는다. 남의 항목 번호를 대면 행이 없어 404가 된다.
const { HttpError, bad, text } = require('./validate');

const KINDS = { project: '준비 중인 프로젝트 메모', apply: '지원하려는 곳', retro: '스스로 쓰는 회고' };

// "예시 넣기" 단추가 넣는 내용. 모두 만들어 넣은 것이고 실제 회사·연락처·번호는 없다.
const EXAMPLES = [
  ['project', '[예시] 다음 과제 메모: 패스키 복구 흐름', '두 번째 기기를 먼저 등록해 두고, 마지막 패스키는 지우지 못하게 막는다. 다음엔 복구용 일회 코드도 검토. (만들어 넣은 내용)'],
  ['apply', '[예시] 가상의 회사 A · 보안 엔지니어(신입)', '마감 가상 날짜 12월 초. 준비물: 포트폴리오 링크, 과제 1~8 정리. (만들어 넣은 내용, 실제 회사 아님)'],
  ['retro', '[예시] 이번 주 회고', '잘한 것: 매일 아침 한 시간 공부. 아쉬운 것: 운동을 두 번 빠짐. 다음 주: 기록을 먼저 쓰고 시작. (만들어 넣은 내용)'],
];

const itemOut = (r) => ({ id: r.id, kind: r.kind, kind_label: KINDS[r.kind], title: r.title, body: r.body, created_at: new Date(r.created_at).toISOString() });

async function list(pool, userId) {
  const { rows } = await pool.query('select * from private_items where user_id = $1 order by id', [userId]);
  return { count: rows.length, items: rows.map(itemOut) };
}

async function get(pool, userId, id) {
  const { rows } = await pool.query('select * from private_items where id = $1 and user_id = $2', [id, userId]);
  if (!rows[0]) throw new HttpError(404, '찾을 수 없습니다');
  return { item: itemOut(rows[0]) };
}

async function create(pool, userId, body) {
  const kind = body.kind;
  if (!Object.hasOwn(KINDS, kind)) throw bad('종류는 project·apply·retro 가운데 하나입니다');
  const title = text(body, 'title', { label: '제목', required: true, max: 80 });
  const b = text(body, 'body', { label: '내용', max: 1000, def: '' });
  const { rows } = await pool.query(
    'insert into private_items (user_id, kind, title, body) values ($1, $2, $3, $4) returning *',
    [userId, kind, title, b],
  );
  return { item: itemOut(rows[0]) };
}

async function remove(pool, userId, id) {
  const r = await pool.query('delete from private_items where id = $1 and user_id = $2', [id, userId]);
  if (!r.rowCount) throw new HttpError(404, '찾을 수 없습니다');
  return { deleted: true };
}

async function addExamples(pool, userId) {
  for (const [kind, title, body] of EXAMPLES) {
    await pool.query('insert into private_items (user_id, kind, title, body) values ($1, $2, $3, $4)', [userId, kind, title, body]);
  }
  return list(pool, userId);
}

module.exports = { KINDS, EXAMPLES, list, get, create, remove, addExamples };
