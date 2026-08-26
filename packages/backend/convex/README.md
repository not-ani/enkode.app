# Enkode backend

Convex is Enkode's required transactional backend. Configure the usual Better Auth variables plus a long, random `DEVELOPER_PROVISIONING_SECRET` in the Convex deployment.

## Provision the first Teacher

Developers create an Organization and its first Teacher through the protected HTTP operation. The password is sent directly to Better Auth and is never stored in Enkode's domain tables or returned by the operation.

```sh
curl "$CONVEX_SITE_URL/api/developer/provision-organization" \
  --request POST \
  --header "Authorization: Bearer $DEVELOPER_PROVISIONING_SECRET" \
  --header "Content-Type: application/json" \
  --data '{
    "organization": { "name": "Example Academy", "slug": "example-academy" },
    "teacher": {
      "name": "Ada Lovelace",
      "username": "ada",
      "email": "ada@example.edu",
      "password": "replace-with-a-strong-password"
    }
  }'
```

The operation is intentionally absent from the web application. Public Better Auth email signup remains disabled at the backend route; provisioned users sign in with the credential a developer or Teacher issued.

## Material attachments

Configure `ENKODE_OBJECT_STORAGE_PROVIDER` and `ENKODE_OBJECT_STORAGE_BUCKET` in the Convex deployment before registering file Materials. The configured upload adapter stores the bytes outside Convex, then passes a provider-neutral receipt containing the object key, original filename, content type, byte size, and SHA-256 digest to Material authoring. Enkode retains that receipt with the immutable Material Version so the attachment can be verified and exported without depending on one storage vendor.

## Work History object storage

Work History manifests and contiguous acknowledgements live in Convex. Compressed immutable chunks and workspace snapshots use path-style S3-compatible object storage configured in the Convex deployment:

- `ENKODE_OBJECT_STORAGE_ENDPOINT`
- `ENKODE_OBJECT_STORAGE_BUCKET`
- `ENKODE_OBJECT_STORAGE_REGION`
- `ENKODE_OBJECT_STORAGE_ACCESS_KEY_ID`
- `ENKODE_OBJECT_STORAGE_SECRET_ACCESS_KEY`

The configured credentials need permission to put objects in the bucket. Enkode uses conditional, content-addressed writes so reconnect and orphan-reconciliation retries cannot replace prior history.
