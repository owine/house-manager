import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export async function startMockOidc(port: number): Promise<{ server: Server; issuer: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const kid = 'test-kid';
  const issuer = `http://localhost:${port}`;
  const sub = 'test-user-sub';
  const code = randomBytes(16).toString('hex');

  const sign = (payload: object) => {
    const header = { alg: 'RS256', kid, typ: 'JWT' };
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc(header)}.${enc(payload)}`;
    const signer = createSign('RSA-SHA256');
    signer.update(data);
    const sig = signer.sign(privateKey).toString('base64url');
    return `${data}.${sig}`;
  };

  const server = createServer((req, res) => {
    if (req.url?.startsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/auth`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
      return;
    }
    if (req.url?.startsWith('/jwks')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, use: 'sig', alg: 'RS256' }] }));
      return;
    }
    if (req.url?.startsWith('/auth')) {
      const url = new URL(req.url, issuer);
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      // Authelia (4.38+) rejects auth requests without `state`. Mirror that
      // strictness so the e2e suite catches any regression where Auth.js
      // stops sending state (the `checks: ['pkce', 'state']` opt-in).
      // 8 chars matches Authelia's default `minimum_parameter_entropy`.
      if (!state || state.length < 8) {
        res.writeHead(302, {
          location: `${redirect}?error=invalid_state&error_description=missing+or+too+short`,
        });
        res.end();
        return;
      }
      res.writeHead(302, { location: `${redirect}?code=${code}&state=${state}` });
      res.end();
      return;
    }
    if (req.url?.startsWith('/token') && req.method === 'POST') {
      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({
        iss: issuer,
        sub,
        aud: 'house-manager',
        exp: now + 3600,
        iat: now,
        email: 'test@example.com',
        name: 'Test User',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          access_token: 'access-token',
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
      return;
    }
    if (req.url?.startsWith('/userinfo')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sub, email: 'test@example.com', name: 'Test User' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, issuer };
}
