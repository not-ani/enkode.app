# Organization Export v1

An Organization Export is a portable JSON object bundle, not a database backup. It contains one
consistent metadata snapshot and embeds every immutable object needed to consume that snapshot.
The media type is `application/vnd.enkode.organization-export+json;version=1`; the matching JSON
Schema is [`organization-export-v1.schema.json`](./organization-export-v1.schema.json).

## Requesting an export

The maintainer-only endpoint is `POST /api/developer/export-organization`. Authenticate with the
same bearer secret used for developer provisioning and send:

```json
{ "organizationSlug": "north-academy" }
```

The endpoint deliberately is not exposed in the web application. One request names exactly one
Organization. All metadata is read in one Convex query transaction and every returned record is
checked against that Organization again before serialization.

## Bundle layout

- `format` is always `enkode.organization-export` and `version` is `1`.
- `organization` identifies the only Organization in the bundle.
- `records` contains users, teaching assignments, Courses, Classrooms, Enrollments, all Assignment
  and Material Versions, source files and tests, releases and version adoptions, deadlines,
  Workspaces and merges, Runs, Submissions and snapshots, Grades and every returned revision,
  Feedback, Integrity Signals (including similarity evidence), and Audit Events. Archived rows,
  ended Enrollments, and retained earlier versions are intentionally not filtered out.
- `objects` contains material attachment bytes, every Work History chunk and referenced Work
  History snapshot, and every Submission snapshot. Objects use a content-addressed
  `objects/sha256/<digest>` path and base64 data. `sourceReferences` links the bytes back to the
  records and fields that require them. Identical immutable bytes are stored once.

Every exported record replaces Convex's `_id` and `_creationTime` properties with portable `id`
and `createdAtInDatabase` properties. Relationships continue to use those string IDs; a consumer
does not need Enkode's database or object-storage credentials. Decode an object's `data`, verify
its byte length and SHA-256 digest, then materialize it at `path` or associate it using
`sourceReferences`.

Active teacher-viewer presence is transient coordination state rather than an academic or
administrative record, so it is not part of v1. Import is outside this format's scope.

## Compatibility

Consumers must reject an unknown `format` or major `version`. Additive record fields may be
ignored. A breaking field, relationship, encoding, or required-record change requires a new
major export version and schema.
