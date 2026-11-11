# Updeacon

[Updeacon](bede.im/updeacon-s3) seamlessly removes human sequences and uploads FASTA/Q files to S3-compatible storage simply by dragging and dropping files into a web browser, facilitating privacy-preserving genomic data sharing. Use it either to send files to a bucket for which you have credentials, or to receive files by generating a pre-authenticated *magic link* to share with the sender, valid for up to 7 days. Updeacon communicates securely and exclusively with the chosen S3 bucket directly from your browser, requiring no third party trust. Updeacon was developed to facilitate responsible data sharing across international borders and engineered to work over unstable internet connections. Using hardware-accelerated WebAssembly, Updeacon is capable of decontaminating sequences at more than 100 Mbp/s, meaning it is typically limited by internet bandwidth. Updeacon uploads a json summary file alongside each uploaded FASTA/Q file detailing the number of retained and discarded bases and records. Updeacon is built from [deacon](https://github.com/bede/deacon) and [sssender](https://github.com/bede/sssender).

**Updeacon may be used in two ways:**

1. **Manual mode** in which S3 bucket credentials are entered manually.
2. **Magic link mode**, in which the receiving party generates a pre-authenticated Updeacon URL and shares it with the sending party. This URL grants upload permission only to a specific prefix in the bucket, and is valid for up to 7 days.

## Creating a magic link as the receiving party

Magic links work using a presigned S3 POST policy authorising uploads anywhere under a specified bucket prefix for up to 7 days.

**From the browser**, follow *mint magic link* at the bottom of the Updeacon page (`/updeacon-s3/mint.html`). Enter the bucket's endpoint and credentials, and press *Make link*. The link is signed in the browser without sending credentials anywhere. The page must be served over HTTPS or from localhost.

**From the command line**, use an AWS CLI profile that can write to the bucket and run:

```sh
scripts/mint-magic-link.sh test-upload --profile climb --endpoint https://s3.climb.ac.uk
```

Uploads go under `updeacon/<name>-<suffix>/` in the bucket. Other flags: `--days`, `--max-bytes`, `--bucket`, `--page`.

Anyone with a magic link can upload to its target bucket prefix until either the request itself or the credentials associated with it expire or are revoked.

## Bucket CORS

This is an important prerequisite for using Updeacon and a common cause of upload failures. The bucket must be configured to allow `PUT`/`POST` from the page's origin and expose `ETag`. Apply [`cors.json`](sssender/cors.json) with `scripts/set-cors.sh`. For CLIMB S3 (set `AWS_ENDPOINT_URL=https://s3.climb.ac.uk`).

## Development

```sh
python3 -m http.server 8000
scripts/mint-magic-link.sh local --page http://localhost:8000
node --test "tests/*.test.mjs"
```
