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
