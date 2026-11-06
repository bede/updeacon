# The S3 endpoint comes from the AWS CLI config: the profile's endpoint_url, or AWS_ENDPOINT_URL.
aws --profile=climb s3api put-bucket-cors --bucket cli-artic-drc-co-inrb-uploads --cors-configuration file://sssender/cors.json
