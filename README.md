# Updeacon

[Updeacon](bede.im/updeacon-s3) seamlessly decontaminates and uploads FASTA/Q files to S3-compatible storage simply by dragging and dropping files into a web browser, facilitating privacy-preserving genomic data sharing. By default, Updeacon depletes human sequences before uploading the remaining sequences directly to a specified S3 bucket inside a timestamped directory. Updeacon communicates exclusively with the chosen S3 bucket and requires no third party trust. Updeacon was developed to facilitate responsible data sharing across international borders and engineered to work over unstable internet connections. Using hardware-accelerated WebAssembly, Updeacon is capable of decontaminating sequences at up to 100 Mbp/s.

**Updeacon may be used in two ways:**

1. **Manual mode** in which S3 bucket credentials are entered manually.
2. **Magic link mode**, in which the receiving party generates a pre-authenticated Updeacon URL and shares it with the receiving party. This URL grants upload permission only to a specific prefix in the bucket, and is valid for up to 7 days.

## Creating a magic link as the receiving party

Magic links work using a presigned S3 POST policy authorising uploads anywhere under a specified bucket prefix for up to 7 days.

**From the browser**, follow *mint magic link* at the bottom of the Updeacon page (`/updeacon-s3/mint.html`). Enter the bucket's endpoint and credentials, and press *Make link*. The link is signed in the browser without sending credentials anywhere. The page must be served over HTTPS or from localhost.

**From the command line**, use an AWS CLI profile that can write to the bucket and run:

```sh
scripts/mint-magic-link.sh test-upload --profile climb --endpoint https://s3.climb.ac.uk
```

Uploads go under `updeacon/<name>-<suffix>/` in the bucket. Other flags: `--days`, `--max-bytes`, `--bucket`, `--page`.

Anyone with a magic link can upload to its target bucket prefix until either the request itself or the credentials associated with it expire or are revoked.

## sssender

Updeacon is built on [sssender](https://github.com/bede/sssender), which uploads any files to S3-compatible storage unmodified ([bede.im/sssender](https://bede.im/sssender/)). sssender replaces seq2bucket. Each app keeps its uploads under its own directory in the bucket (`updeacon/`, `sssender/`), so they never clash. sssender is vendored into [`sssender/`](sssender/).

## Bucket CORS

This is an important prerequisite for using Updeacon and the most common cause of upload failures. The bucket must be configured to allow `PUT`/`POST` from the page's origin and expose `ETag`. Apply [`cors.json`](sssender/cors.json) with `sh set-cors.sh` (set `AWS_ENDPOINT_URL=https://s3.climb.ac.uk` for CLIMB).

## Development

```sh
python3 -m http.server 8000                                   # then open / or /sapiometer/
scripts/mint-magic-link.sh smoke --page http://localhost:8000
node --test "tests/*.test.mjs"
```

`scripts/deploy.sh` copies the apps into the `bede.github.io` site and pushes. `scripts/sync-wasm.sh` updates the Deacon bundle in `pkg/` from `../deacon`. `scripts/sync-sssender.sh` vendors sssender from `../sssender`. The release version is in [`version.js`](version.js).
