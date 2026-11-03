#!/usr/bin/env python3
"""Mint a magic link: a presigned upload link for updeacon-s3 or seq2bucket.

Signs an S3 POST policy whose `starts-with` condition on `$key` authorises uploads
anywhere under a prefix, and packs it into the URL fragment of the upload page.
Works for any number of files, so the link is reusable until it expires. Each upload
gets its own timestamped subdir inside the prefix.

Needs the AWS CLI configured for the target bucket. The S3 endpoint comes from
--endpoint, else AWS_ENDPOINT_URL_S3 / AWS_ENDPOINT_URL, else the profile's
`endpoint_url`. No third-party packages.

For CLIMB:

    scripts/mint-magic-link.py inrb-batch3 --profile climb --endpoint https://s3.climb.ac.uk

--raw mints a link to the seq2bucket page, which uploads files with no human
depletion, under a raw/ prefix. Without it, the link opens updeacon-s3, which
filters with Deacon first. The page decides the behaviour; the policy is the same.
"""

import argparse
import base64
import hashlib
import hmac
import json
import re
import secrets
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

BUCKET = "cli-artic-drc-co-inrb-uploads"
REGION = "us-east-1"  # dummy; Ceph RGW ignores it but it must match the signature
BASE_URL = "https://bede.im/updeacon-s3/"  # filters with Deacon, then uploads
RAW_BASE_URL = "https://bede.im/seq2bucket/"  # uploads files without filtering

ALGORITHM = "AWS4-HMAC-SHA256"
POST_MAX_BYTES = 5 * 1024**3  # S3 POST Object caps a single upload at 5 GB
MAX_DAYS = 7  # SigV4 signatures are invalid beyond 604800 s
SUFFIX_LETTERS = "abcdefghijklmnopqrstuvwxyz"
SUFFIX_DIGITS = "0123456789"
RAW_ROOT = "raw/"  # keeps unfiltered uploads out of paths assumed to be human-depleted


def _hmac(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def signing_key(secret: str, datestamp: str, region: str, service: str) -> bytes:
    k = _hmac(f"AWS4{secret}".encode("utf-8"), datestamp)
    k = _hmac(k, region)
    k = _hmac(k, service)
    return _hmac(k, "aws4_request")


def sanitise(name: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]+", "-", name.strip().lower())
    slug = re.sub(r"-{2,}", "-", slug).strip("-.")
    if not slug:
        raise SystemExit("error: name must contain at least one alphanumeric character")
    return slug


def make_prefix(name: str, raw: bool = False) -> str:
    """The suffix avoids collisions, not guessing; the signature is the secret."""
    suffix = "".join(
        secrets.choice(SUFFIX_LETTERS if i % 2 == 0 else SUFFIX_DIGITS) for i in range(4)
    )
    return f"{RAW_ROOT if raw else ''}{sanitise(name)}-{suffix}/"


def resolve_credentials(profile, allow_session_token):
    cmd = ["aws", "configure", "export-credentials", "--format", "process"]
    if profile:
        cmd += ["--profile", profile]
    try:
        out = subprocess.run(cmd, check=True, capture_output=True, text=True).stdout
    except FileNotFoundError:
        raise SystemExit("error: the aws CLI is not on PATH")
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"error: could not resolve AWS credentials\n{exc.stderr.strip()}")

    creds = json.loads(out)
    if creds.get("SessionToken") and not allow_session_token:
        raise SystemExit(
            "error: these are temporary credentials (they carry a session token).\n"
            "The link would stop working the moment the session expires, long before\n"
            "its stated lifetime. Sign with long-lived IAM user keys instead, or pass\n"
            "--allow-session-token if you understand the link will expire early."
        )
    return creds["AccessKeyId"], creds["SecretAccessKey"], creds.get("SessionToken")


def resolve_endpoint(explicit, profile):
    """Return (endpoint, source): --endpoint, else env, else the AWS CLI profile."""
    for value, source in (
        (explicit, "--endpoint"),
        (os.environ.get("AWS_ENDPOINT_URL_S3"), "AWS_ENDPOINT_URL_S3"),
        (os.environ.get("AWS_ENDPOINT_URL"), "AWS_ENDPOINT_URL"),
    ):
        if value:
            return value.rstrip("/"), source
    cmd = ["aws", "configure", "get", "endpoint_url"]
    if profile:
        cmd += ["--profile", profile]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        raise SystemExit("error: the aws CLI is not on PATH")
    if not out:
        raise SystemExit(
            "error: no S3 endpoint configured. Pass --endpoint, set AWS_ENDPOINT_URL, or add\n"
            "`endpoint_url = https://...` to the AWS CLI profile. For CLIMB:\n"
            "  --endpoint https://s3.climb.ac.uk"
        )
    return out.rstrip("/"), f"profile {profile or 'default'}"


def build_policy(bucket, prefix, region, access_key, session_token, expires_at, now, max_bytes):
    datestamp = now.strftime("%Y%m%d")
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    credential = f"{access_key}/{datestamp}/{region}/s3/aws4_request"

    conditions = [
        {"bucket": bucket},
        # Authorise a key pattern, not a key
        ["starts-with", "$key", prefix],
        ["content-length-range", 0, max_bytes],
        # Empty value matches anything
        ["starts-with", "$Content-Type", ""],
        {"x-amz-algorithm": ALGORITHM},
        {"x-amz-credential": credential},
        {"x-amz-date": amz_date},
    ]
    fields = {
        "x-amz-algorithm": ALGORITHM,
        "x-amz-credential": credential,
        "x-amz-date": amz_date,
    }
    if session_token:
        conditions.append({"x-amz-security-token": session_token})
        fields["x-amz-security-token"] = session_token

    policy = {
        "expiration": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "conditions": conditions,
    }
    # These exact bytes are signed and posted
    encoded = base64.b64encode(
        json.dumps(policy, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    fields["policy"] = encoded
    return fields, datestamp, encoded


def sign_policy(fields, secret, datestamp, region, encoded_policy):
    key = signing_key(secret, datestamp, region, "s3")
    # No canonical request; the base64 policy is the string to sign
    fields["x-amz-signature"] = hmac.new(
        key, encoded_policy.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return fields


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def self_test():
    """AWS's published SigV4 signing-key derivation example."""
    got = signing_key(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20120215", "us-east-1", "iam"
    ).hex()
    want = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
    if got != want:
        print(f"FAIL signing key\n  got  {got}\n  want {want}", file=sys.stderr)
        return 1

    # A round-trip the browser must decode
    prefix = make_prefix("Smoke Test!!")
    if not re.fullmatch(r"smoke-test-([a-z][0-9]){2}/", prefix):
        print(f"FAIL prefix shape: {prefix}", file=sys.stderr)
        return 1

    now = datetime(2026, 7, 9, 14, 22, 0, tzinfo=timezone.utc)
    fields, datestamp, encoded = build_policy(
        "b", prefix, "us-east-1", "AKIAEXAMPLE", None,
        now + timedelta(days=7), now, POST_MAX_BYTES,
    )
    sign_policy(fields, "secret", datestamp, "us-east-1", encoded)
    policy = json.loads(base64.b64decode(fields["policy"]))
    assert ["starts-with", "$key", prefix] in policy["conditions"]
    assert policy["expiration"] == "2026-07-16T14:22:00Z"
    assert len(fields["x-amz-signature"]) == 64

    raw_prefix = make_prefix("Smoke Test!!", raw=True)
    if not re.fullmatch(r"raw/smoke-test-([a-z][0-9]){2}/", raw_prefix):
        print(f"FAIL raw prefix shape: {raw_prefix}", file=sys.stderr)
        return 1

    print("self-test ok")
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("name", nargs="?", help="human label for the upload; a random suffix is appended")
    p.add_argument("--profile", help="AWS CLI profile to sign with")
    p.add_argument("--bucket", default=BUCKET)
    p.add_argument("--endpoint", help="S3 endpoint URL (default: from the AWS CLI config)")
    p.add_argument("--region", default=REGION)
    p.add_argument(
        "--base-url",
        help=f"page the link opens (default: {BASE_URL}, or {RAW_BASE_URL} with --raw)",
    )
    p.add_argument("--days", type=int, default=MAX_DAYS, help=f"link lifetime (max {MAX_DAYS})")
    p.add_argument("--max-bytes", type=int, default=POST_MAX_BYTES, help="per-object size cap")
    p.add_argument("--allow-session-token", action="store_true")
    p.add_argument(
        "--raw",
        action="store_true",
        help="link to seq2bucket: upload files WITHOUT human depletion (prefix under raw/)",
    )
    p.add_argument("--self-test", action="store_true", help="verify signing against AWS test vectors")
    args = p.parse_args()

    if args.self_test:
        raise SystemExit(self_test())
    if not args.name:
        p.error("an upload name is required, e.g. `mint-magic-link.py inrb-batch3`")
    if not 1 <= args.days <= MAX_DAYS:
        p.error(f"--days must be between 1 and {MAX_DAYS} (SigV4 signatures cannot outlive 7 days)")
    if not 1 <= args.max_bytes <= POST_MAX_BYTES:
        p.error(f"--max-bytes must be between 1 and {POST_MAX_BYTES} (S3 POST Object limit)")

    endpoint, endpoint_source = resolve_endpoint(args.endpoint, args.profile)
    access_key, secret, token = resolve_credentials(args.profile, args.allow_session_token)

    now = datetime.now(timezone.utc).replace(microsecond=0)
    expires_at = now + timedelta(days=args.days)
    prefix = make_prefix(args.name, raw=args.raw)

    fields, datestamp, encoded = build_policy(
        args.bucket, prefix, args.region, access_key, token, expires_at, now, args.max_bytes
    )
    sign_policy(fields, secret, datestamp, args.region, encoded)

    payload = {"v": 1, "endpoint": endpoint, "fields": fields}
    blob = b64url(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    base_url = args.base_url or (RAW_BASE_URL if args.raw else BASE_URL)
    link = f"{base_url.rstrip('/')}/#u={blob}"

    print(f"endpoint {endpoint} ({endpoint_source})")
    print(f"bucket   {args.bucket}")
    print(f"prefix   {prefix}")
    print(f"expires  {expires_at.strftime('%Y-%m-%dT%H:%M:%SZ')} ({args.days} days)")
    print(f"max size {args.max_bytes / 1024**3:.1f} GB per file")
    print(f"page     {base_url} ({'raw: NO human depletion' if args.raw else 'Deacon filtering'})")
    print()
    print(link)
    print()
    print("Anyone with this link can upload into that prefix until it expires.", file=sys.stderr)
    print("They cannot list, read or delete anything. Share it like a password.", file=sys.stderr)
    if args.raw:
        print(
            "RAW LINK: files are uploaded without filtering. Human reads are NOT removed.",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
