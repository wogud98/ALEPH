'use strict';
// 검사·기록용 가상 인증기. 실제 기기가 하는 일(열쇠 한 쌍 만들기, 질문에 서명하기)을 Node에서 똑같이 한다.
//   * 개인키는 이 객체 안(this.keys)에만 있고, 서버로 보내는 JSON에는 공개키(COSE)와 서명만 들어간다.
//   * 서버 입장에서는 실제 휴대폰·보안 키와 구별할 수 없는 WebAuthn 응답이다 (attestation 형식 none).
// 검사에서만 쓰고 서비스 코드(src/)는 이 파일을 쓰지 않는다.
const crypto = require('node:crypto');
const { isoCBOR, isoBase64URL } = require('@simplewebauthn/server/helpers');

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// 가상 인증기 종류 번호. 실제 제품 번호와 겹치지 않게 만든 값.
const SOFT_AAGUID = Buffer.from('7e570000000000000000000000000008', 'hex');

class SoftAuthenticator {
  constructor({ origin, rpId, label = 'soft' }) {
    this.origin = origin;
    this.rpId = rpId || new URL(origin).hostname;
    this.label = label;
    this.keys = new Map(); // credentialId(base64url) -> { privateKey, publicCose, userHandle, counter }
  }

  authData({ flags, counter, attested }) {
    const head = Buffer.alloc(37);
    sha256(this.rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(counter, 33);
    return attested ? Buffer.concat([head, attested]) : head;
  }

  // navigator.credentials.create() 흉내. options는 서버가 보낸 JSON 그대로.
  create(options) {
    const exclude = (options.excludeCredentials || []).map((c) => c.id);
    for (const id of this.keys.keys()) {
      if (exclude.includes(id)) {
        const e = new Error('이 인증기에는 이미 이 계정의 패스키가 있습니다');
        e.name = 'InvalidStateError';
        throw e;
      }
    }
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    // COSE_Key: kty=2(EC2), alg=-7(ES256), crv=1(P-256), x, y. 개인키 d는 넣지 않는다.
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
    const publicCose = Buffer.from(isoCBOR.encode(cose));
    const credId = crypto.randomBytes(16);
    const attested = Buffer.concat([SOFT_AAGUID, Buffer.from([0, credId.length]), credId, publicCose]);
    // flags: UP(0x01) | UV(0x04) | AT(0x40)
    const authData = this.authData({ flags: 0x45, counter: 0, attested });
    const attObj = isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const id = b64u(credId);
    this.keys.set(id, { privateKey, publicCose, userHandle: options.user.id, counter: 0 });
    return {
      id, rawId: id, type: 'public-key',
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj), transports: ['internal'] },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  // navigator.credentials.get() 흉내. credentialId를 고르지 않으면 가진 것 가운데 첫 번째를 쓴다.
  get(options, { credentialId, userHandle, tamper } = {}) {
    const id = credentialId || [...this.keys.keys()][0];
    const k = this.keys.get(id);
    if (!k) throw new Error('이 인증기에 그 패스키가 없습니다');
    k.counter += 1;
    const authData = this.authData({ flags: 0x05, counter: k.counter });
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    let sig = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), k.privateKey);
    if (tamper === 'signature') {
      // 서명 한 바이트를 바꿔 "틀린 서명"을 만든다.
      sig = Buffer.from(sig);
      sig[sig.length - 1] ^= 0x01;
    }
    return {
      id, rawId: id, type: 'public-key',
      response: {
        clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig),
        userHandle: userHandle || k.userHandle,
      },
      clientExtensionResults: {}, authenticatorAttachment: 'platform',
    };
  }

  credentialIds() { return [...this.keys.keys()]; }
  forget(id) { this.keys.delete(id); }
}

// 등록 요청 본문을 풀어 무엇이 들어 있는지 보여 준다 (개인키가 없다는 증거용).
function explainRegistration(body) {
  const r = body.response.response;
  const att = isoCBOR.decodeFirst(isoBase64URL.toBuffer(r.attestationObject));
  const authData = Buffer.from(att.get('authData'));
  const credLen = authData.readUInt16BE(53);
  const coseBytes = authData.subarray(55 + credLen);
  const cose = isoCBOR.decodeFirst(new Uint8Array(coseBytes));
  return {
    clientDataJSON: JSON.parse(Buffer.from(r.clientDataJSON, 'base64url').toString('utf8')),
    attestationObject: { fmt: att.get('fmt'), attStmt_keys: [...att.get('attStmt').keys()], authData_bytes: authData.length },
    credentialPublicKey: describeCose(cose),
  };
}

// COSE 공개키를 사람이 읽을 수 있게 푼다.
function describeCose(cose) {
  const m = cose instanceof Map ? cose : isoCBOR.decodeFirst(new Uint8Array(cose));
  const name = { 1: 'kty', 3: 'alg', '-1': 'crv', '-2': 'x', '-3': 'y', '-4': 'd(개인키)' };
  const out = {};
  for (const [k, v] of m) out[name[k] || String(k)] = v instanceof Uint8Array ? `${b64u(v).slice(0, 12)}…(${v.length}바이트)` : v;
  out.has_private_d = m.has(-4);
  return out;
}

module.exports = { SoftAuthenticator, explainRegistration, describeCose, SOFT_AAGUID };
