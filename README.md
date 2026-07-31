# updeacon

A client-side web tool that dehosts `fastq`/`fasta` files (optionally `.gz`) with
[Deacon](https://github.com/bede/deacon) and uploads the cleaned reads to
S3-compatible object storage. Human reads are removed in the browser, so
contaminant sequences never leave the machine. Files land in a timestamped folder
with their original names and directory structure preserved. Output is always
gzip-compressed; an uncompressed input is uploaded with a `.gz` suffix added.

Filtering runs as WebAssembly ([`pkg/`](pkg/)) inside a Web Worker
([`worker.js`](worker.js)), keeping the UI responsive. An index is required. The
compact [panhuman-1](https://objectstorage.uk-london-1.oraclecloud.com/n/lrbvkel2wjot/b/human-genome-bucket/o/deacon/3/panhuman-1.k31w25c9b16.pidx)
index is downloaded on first use and cached in IndexedDB.

## Two ways to upload

**Presigned link** (recommended for collaborators). Someone with bucket access
sends a URL. Opening it authorises uploads into one prefix for up to 7 days, with
no credentials to distribute or leak.

**S3 credentials.** Open the app with no link and enter an access key ID and
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

Send that URL to whoever is uploading. The `letter-digit-letter-digit` suffix
avoids collisions between links; it is not a secret.

The link is reusable until it expires. Each upload creates its own timestamped
directory inside the prefix, so repeat uploads never overwrite one another:

```
inrb-batch3-k7q2/
├── 2026-07-09T14-30-00Z--flowcell1/
│   ├── sample_R1.fastq.gz
│   ├── sample_R1.fastq.gz.deacon.json
│   ├── _CLIENT.json
│   └── _MANIFEST.txt
└── 2026-07-11T09-02-13Z--flowcell2/
```

`_MANIFEST.txt` is written last and lists every object uploaded, so its presence
means the upload completed in full. `_CLIENT.json` is written first, before any
filtering: it confirms the link can write, and records who uploaded what (updeacon
version and commit, deacon version, index, browser, OS, timezone, and the number
and size of files intended). A directory with a `_CLIENT.json` but no
`_MANIFEST.txt` was interrupted before it finished.

Useful flags: `--days N` (max 7), `--max-bytes N`, `--bucket`, `--endpoint`,
`--base-url`, `--region`. `--self-test` checks the signing implementation against
AWS's published SigV4 test vectors.

### How it works, and what it grants

A presigned `PUT` URL signs one object key, which is useless when uploading many
files whose names aren't known in advance. This instead signs an S3 POST policy
containing `["starts-with", "$key", "inrb-batch3-k7q2/"]`: one signature
authorising any key under that prefix.

The object store enforces that. A leaked link can write anywhere under its own
prefix and nothing else. It cannot list, read, or delete, each object is capped
(5 GB by default), and it stops working at expiry. It can overwrite objects within
its own prefix, so enable bucket versioning if that matters. Rotating the signing
key invalidates every outstanding link at once.

The signed policy travels in the URL fragment, which browsers never send to the
web server, so it stays out of GitHub Pages logs and `Referer` headers. It is
still a bearer credential: share it like a password.

Sign with long-lived IAM user keys. SigV4 caps signature validity at 7 days, and
temporary credentials would invalidate the link the moment the session expires;
the script refuses them unless you pass `--allow-session-token`.

## Limitations

Linked uploads are capped at 5 GB per file. `POST Object` is a single-shot upload
with no multipart support and a hard 5 GB object limit, so a link cannot post
anything larger. Credential-mode uploads stream into a multipart upload and have
no such cap. In link mode the filtered output is spooled to an Origin Private File
System temp file before being posted, so memory stays bounded either way. Output
is never larger than input (depletion only removes reads, and output compression
matches input), so an input file under 5 GB always fits.

Because a signed POST is not resumable, a connection failure retries the current
object from byte zero. Slow transfers are allowed to run indefinitely while bytes
continue moving; prolonged upload or response silence is timed out and retried.
Large linked uploads require browser OPFS support and enough available origin
storage for the filtered output. Browsers without OPFS retain an in-memory fallback
only for outputs up to 64 MiB.

## Configuration

Defaults live at the top of [`app.js`](app.js) and
[`scripts/mint-upload-link.py`](scripts/mint-upload-link.py):

| Setting     | Value                               |
| ----------- | ----------------------------------- |
| Endpoint    | `https://s3.climb.ac.uk` (Ceph RGW) |
| Bucket      | `cli-artic-drc-co-inrb-uploads`     |
| Region      | `us-east-1` (dummy; RGW ignores it) |
| Addressing  | path-style (`forcePathStyle: true`) |

## Bucket CORS (required)

A browser cannot upload unless the bucket allows this page's origin and exposes
the `ETag` header. Multipart uploads read each part's ETag; presigned POSTs carry
an upload-progress listener, which makes them non-simple requests and triggers a
CORS preflight that the bucket must answer. Apply [`cors.json`](cors.json):

```sh
sh set-cors.sh
```

Tighten `AllowedOrigins` from `*` to the exact serving origin in production.

The index host must also allow cross-origin `GET`, and expose `Content-Length` for
an accurate progress bar. If it doesn't, the download fails and the index panel
becomes a drop target for a local `.idx`/`.pidx`.

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
pushes.
