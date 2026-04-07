# TLS Configuration for RemoteAdapter

The RemoteAdapter communicates with the ideate-server via GraphQL over HTTP. For production deployments, you should use HTTPS with proper TLS configuration.

## Basic HTTPS

To use HTTPS, simply provide an `https://` endpoint URL:

```typescript
const adapter = new RemoteAdapter({
  endpoint: "https://ideate-server.example.com/graphql",
  org_id: "my-org",
  codebase_id: "my-codebase",
  auth_token: process.env.IDEATE_AUTH_TOKEN,
});
```

Node.js automatically validates the server's certificate against the system's CA store.

## Environment Variables

### Node.js TLS Environment Variables

Node.js respects standard TLS environment variables:

- `NODE_EXTRA_CA_CERTS` - Path to a file containing additional CA certificates
- `SSL_CERT_FILE` - Path to CA bundle (OpenSSL)
- `SSL_CERT_DIR` - Path to CA certificates directory

Example:
```bash
export NODE_EXTRA_CA_CERTS=/path/to/ca-certificates.crt
```

## mTLS (Mutual TLS)

For deployments requiring client certificate authentication, use a custom fetch agent. The RemoteAdapter accepts an optional `fetch` implementation in the constructor options.

### Using node-fetch with custom agent

```typescript
import { RemoteAdapter } from "@ideate/artifact-server/adapters/remote";
import https from "node:https";

// Create HTTPS agent with client certificates
const agent = new https.Agent({
  cert: fs.readFileSync("/path/to/client-cert.pem"),
  key: fs.readFileSync("/path/to/client-key.pem"),
  ca: fs.readFileSync("/path/to/ca-cert.pem"), // Optional: custom CA
  rejectUnauthorized: true, // Set to false only for development
});

// Custom fetch wrapper that uses the agent
const customFetch = (url: string, init: RequestInit) => {
  return fetch(url, {
    ...init,
    agent, // Node.js fetch accepts agent option
  } as RequestInit);
};

const adapter = new RemoteAdapter({
  endpoint: "https://ideate-server.example.com/graphql",
  org_id: "my-org",
  codebase_id: "my-codebase",
  auth_token: process.env.IDEATE_AUTH_TOKEN,
}, customFetch);
```

### Using undici (recommended for production)

```typescript
import { Agent } from "undici";
import { RemoteAdapter } from "@ideate/artifact-server/adapters/remote";

const agent = new Agent({
  connect: {
    cert: fs.readFileSync("/path/to/client-cert.pem"),
    key: fs.readFileSync("/path/to/client-key.pem"),
    ca: fs.readFileSync("/path/to/ca-cert.pem"),
    servername: "ideate-server.example.com",
  },
});

// Pass agent to RemoteAdapter via custom fetch
const customFetch = (url: string, init: RequestInit) => {
  return fetch(url, { ...init, dispatcher: agent });
};

const adapter = new RemoteAdapter({
  endpoint: "https://ideate-server.example.com/graphql",
  org_id: "my-org",
  codebase_id: "my-codebase",
  auth_token: process.env.IDEATE_AUTH_TOKEN,
}, customFetch);
```

## Production Checklist

- [ ] Use HTTPS endpoints (not HTTP)
- [ ] Pin server certificate or use proper CA validation
- [ ] Enable mTLS if required by your security policy
- [ ] Rotate auth tokens regularly (see WI-634 for token rotation)
- [ ] Store certificates and keys in secure vault (not in code)
- [ ] Configure proper certificate expiry monitoring

## Security Notes

1. **Certificate Validation**: By default, Node.js validates server certificates. Never disable `rejectUnauthorized` in production.

2. **Client Certificates**: When using mTLS, protect your private keys. Use hardware security modules (HSMs) or secret management services.

3. **Auth Tokens**: The `auth_token` is sent in the `Authorization` header. Ensure your transport is encrypted (HTTPS).

4. **Cipher Suites**: Node.js uses secure defaults. For specific compliance requirements (FIPS, etc.), configure Node.js with `--openssl-config`.

## Troubleshooting

### Certificate Validation Errors

If you see `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or similar errors:

1. Check that the server's certificate chain is complete
2. Add any custom CAs via `NODE_EXTRA_CA_CERTS`
3. Verify the certificate hasn't expired: `openssl x509 -in cert.pem -noout -dates`

### Connection Refused

- Verify the endpoint URL and port
- Check firewall rules allow outbound HTTPS (port 443)
- Verify DNS resolution: `nslookup ideate-server.example.com`

### mTLS Authentication Failures

- Verify client certificate hasn't expired
- Check that the server trusts the client's CA
- Ensure the client key matches the certificate
- Verify certificate chain completeness

## See Also

- [RemoteAdapter API](../src/adapters/remote/index.ts)
- [GraphQL Client](../src/adapters/remote/client.ts)
- [WI-634: Auth Token Rotation](https://github.com/ideate/project/issues/634)
