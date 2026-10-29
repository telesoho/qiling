# Swagger UI

Unchanged files from `swagger-ui-dist@5.34.0` (Apache-2.0):

- `swagger-ui-bundle.js` and `swagger-ui-bundle.js.LICENSE.txt`
- `swagger-ui.css`
- `favicon-32x32.png`
- `LICENSE` and `NOTICE`

`src-tauri/src/http.rs` embeds them and serves them under `/docs/`, so the
Swagger UI page works offline. `docs/swagger.html` is the page that loads them,
and `docs/openapi.yaml` is the protocol it renders.

To upgrade, fetch the same files from a newer `swagger-ui-dist` tarball:

```bash
npm pack swagger-ui-dist@<version>
tar -xzf swagger-ui-dist-<version>.tgz
```
