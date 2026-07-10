# updeacon

A fully client-side web tool that **dehosts** `fastq`/`fasta` files (optionally
`.gz`) with [Deacon](https://github.com/bede/deacon) and uploads the cleaned reads
to S3-compatible object storage. Human reads are removed in the browser, so
contaminant sequences never leave the machine. Files land in a timestamped folder
with their original names and directory structure preserved.

Filtering runs as WebAssembly ([`pkg/`](pkg/)) inside a Web Worker
([`worker.js`](worker.js)), so the UI stays responsive. An index is required; the
compact [panhuman-1](https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w21.pidx)
index is downloaded on first use and cached in IndexedDB.

## Two ways to upload

**With a presigned link** (recommended for collaborators). Someone with bucket
access sends a URL. Opening it authorises uploads into one prefix, for up to 7
days — no credentials to distribute, type, or leak.

**With S3 credentials.** Open the app with no link and enter an access key ID and
secret access key. Uploads stream directly into a multipart upload, so there is no
per-file size limit.

## Creating a presigned upload link

Run on a machine whose AWS CLI can write to the bucket:

```sh
scripts/mint-upload-link.py inrb-batch3 --profile climb
```

```
bucket   cli-artic-drc-co-inrb-uploads
prefix   inrb-batch3-k7q2/
expires  2026-07-16T14:22:00Z (7 days)
max size 5.0 GB per file

https://bede.github.io/updeacon-s3/#u=eyJ2IjoxLCJlbmRwb2ludCI6...
```

Send that URL to whoever is uploading. The four random characters avoid
collisions between links; they are not a secret.

The link is **reusable** until it expires. Each upload creates its own timestamped
directory inside the prefix, so repeat uploads never overwrite one another:

```
inrb-batch3-k7q2/
├── 2026-07-09T14-30-00Z--flowcell1/
│   ├── sample_R1.fastq.gz
│   ├── sample_R1.fastq.gz.deacon.json
│   ├── _UPLOAD_STARTED.txt
│   └── _MANIFEST.txt
└── 2026-07-11T09-02-13Z--flowcell2/
```

`_MANIFEST.txt` is written **last** and lists every object uploaded, so its
presence means the upload completed in full. `_UPLOAD_STARTED.txt` is written
first: a directory with one and not the other died partway.

Useful flags: `--days N` (≤ 7), `--max-bytes N`, `--bucket`, `--endpoint`,
`--base-url`, `--region`. `--self-test` checks the signing implementation against
AWS's published SigV4 test vectors.

### How it works, and what it grants

A presigned `PUT` URL signs one object key, which is useless when uploading many
files whose names aren't known in advance. This instead signs an S3 **POST
policy** containing `["starts-with", "$key", "inrb-batch3-k7q2/"]` — one signature
authorising any key under that prefix.

The object store enforces that. A leaked link can write anywhere under its own
prefix and nothing else: it cannot list, read, or delete, each object is capped
(5 GB by default), and it stops working at expiry. It *can* overwrite objects
within its own prefix, so enable bucket versioning if that matters. Rotating the
signing key invalidates every outstanding link at once.

The signed policy travels in the URL **fragment**, which browsers never send to
the web server — it stays out of GitHub Pages logs and `Referer` headers. It is
still a bearer credential: share it like a password.

Sign with long-lived IAM user keys. SigV4 caps signature validity at 7 days, and
temporary credentials would invalidate the link the moment the session expires;
the script refuses them unless you pass `--allow-session-token`.

### Why linked uploads are capped at 5 GB per file

`POST Object` is a single-shot upload with no multipart support and a hard 5 GB
object limit. Credential-mode uploads stream into a multipart upload and have no
such cap. In link mode the filtered output is spooled to an Origin Private File
System temp file before being posted, so memory stays bounded either way. Output
is never larger than input (depletion only removes reads, and output compression
matches input), so an input file under 5 GB always fits.

## Configuration

Defaults live at the top of [`app.js`](app.js) and
[`scripts/mint-upload-link.py`](scripts/mint-upload-link.py):

| Setting     | Value                               |
| ----------- | ----------------------------------- |
| Endpoint    | `https://s3.climb.ac.uk` (Ceph RGW) |
| Bucket      | `cli-artic-drc-co-inrb-uploads`     |
| Region      | `us-east-1` (dummy; RGW ignores it) |
| Addressing  | path-style (`forcePathStyle: true`) |

## Bucket CORS — required

A browser cannot upload unless the bucket allows this page's origin and exposes
the `ETag` header. Multipart uploads read each part's ETag; presigned POSTs carry
an upload-progress listener, which makes them non-simple requests and so triggers
a CORS preflight that the bucket must answer. Apply [`cors.json`](cors.json):

```sh
sh set-cors.sh
```

Tighten `AllowedOrigins` from `*` to the exact serving origin in production.

The index host must also allow cross-origin `GET` (and expose `Content-Length`
for an accurate progress bar). If it doesn't, the download fails and the index
panel becomes a drop target for a local `.idx`/`.pidx`.

## Running locally

No build step, no CDN. Serve over HTTP (ES modules don't load from `file://`):

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`. To exercise link mode, mint a link pointing at
your local server:

```sh
scripts/mint-upload-link.py smoke --base-url http://localhost:8000
```

Tests: `node --test "tests/*.test.mjs"` and `scripts/mint-upload-link.py --self-test`.

## Deploying

`scripts/deploy.sh` copies both apps into the `bede.github.io` Jekyll site and
pushes. See [`AGENTS.md`](AGENTS.md) for repository internals.

## Security note

In credential mode, keys are entered in the browser and sent only to the
configured endpoint over HTTPS. The secret access key is never persisted. Even so,
pasting long-lived secret keys into a web form is risky — prefer a presigned link,
which grants write-only access to a single prefix for a bounded time.
