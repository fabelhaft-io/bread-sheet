#!/usr/bin/env bash
# Operator commands for the dev stack's Tier 3 pause/resume cycle (TICKET-P9-009).
#
#   scripts/dev-stack.sh status                      uptime, time left until auto-teardown,
#                                                    switches, snapshots
#   scripts/dev-stack.sh resume [--snapshot ID] [--image REF] [-- <terraform args>]
#                                                    restore from the newest snapshot, on the
#                                                    image it was taken under
#   scripts/dev-stack.sh plan   [--image REF] [-- <terraform args>]
#   scripts/dev-stack.sh apply  [--image REF] [-- <terraform args>]
#                                                    plan/apply with server_image read from the
#                                                    live service
#
# Runs locally with your own AWS credentials, never in CI. The scheduled teardown is
# .github/workflows/dev-auto-teardown.yml. Resume stays a human action on purpose: automating it
# would give a CI role create permissions across RDS, ECS and IAM.
#
# Needs: aws, terraform, jq, curl, node; gh (optional, for `status` to read the repo variables).
# See docs/architecture/infrastructure.md § Pausing / Resuming the Dev Stack.

set -euo pipefail

REGION=eu-west-1
DB_INSTANCE=breadsheet-dev-database-1
CLUSTER=breadsheet-server-dev
SERVICE=breadsheet-dev-server-service
IMAGE_REPO=ghcr.io/fabelhaft-io/bread-sheet-server

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TF_DIR="$ROOT/terraform"
TEARDOWN_JS="$ROOT/scripts/ops/dev-teardown.mjs"
TF_VARS=(-var-file=environments/dev.tfvars)

die() { echo "dev-stack: $*" >&2; exit 1; }
note() { echo "dev-stack: $*" >&2; }

for bin in aws terraform jq curl node; do
  command -v "$bin" >/dev/null || die "'$bin' is not on PATH."
done

tf() { terraform -chdir="$TF_DIR" "$@"; }

ensure_init() {
  [ -d "$TF_DIR/.terraform" ] && return
  note "terraform not initialised — running init against the dev backend"
  tf init -input=false -backend-config=environments/dev.s3.tfbackend
}

# Prints the describe-db-instances JSON, or the literal "none" when the instance does not exist.
# Any other error (expired session, throttling) is fatal: "not found" must never be inferred
# from a failed call.
db_instance_json() {
  local out err
  err=$(mktemp)
  if out=$(aws rds describe-db-instances --region "$REGION" \
      --db-instance-identifier "$DB_INSTANCE" --output json 2>"$err"); then
    rm -f "$err"
    printf '%s\n' "$out"
  elif grep -q DBInstanceNotFound "$err"; then
    rm -f "$err"
    echo none
  else
    out=$(cat "$err"); rm -f "$err"
    die "describe-db-instances failed: $out"
  fi
}

service_status() {
  aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].status' --output text
}

# The image of the revision the service is running right now, not Terraform's frozen copy.
live_image() {
  local td
  td=$(aws ecs describe-services --region "$REGION" --cluster "$CLUSTER" --services "$SERVICE" \
    --query 'services[0].taskDefinition' --output text)
  [ -n "$td" ] && [ "$td" != None ] || return 1
  aws ecs describe-task-definition --region "$REGION" --task-definition "$td" \
    --query 'taskDefinition.containerDefinitions[0].image' --output text
}

manual_snapshots_json() {
  aws rds describe-db-snapshots --region "$REGION" --snapshot-type manual --output json
}

# Fails unless GHCR serves a manifest for the image. Otherwise a bad pin only surfaces after the
# DB restore, as CannotPullContainerError tripping the circuit breaker, and a healthy snapshot
# looks like the culprit.
check_image_exists() {
  local image=$1 repo ref path token code
  case "$image" in
    "$IMAGE_REPO"@sha256:*) ref=${image#"$IMAGE_REPO"@} ;;
    "$IMAGE_REPO":*) ref=${image#"$IMAGE_REPO":} ;;
    *) die "image '$image' is not in $IMAGE_REPO." ;;
  esac
  repo=${IMAGE_REPO#ghcr.io/}
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:${repo}:pull&service=ghcr.io" | jq -r .token)
  path="https://ghcr.io/v2/${repo}/manifests/${ref}"
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "$path")
  [ "$code" = 200 ] || die "GHCR returned HTTP $code for $image — that image cannot be pulled. Pass --image <ref>."
  note "image $image resolves on GHCR (200)"
}

gh_var() { command -v gh >/dev/null && gh variable get "$1" 2>/dev/null || true; }

cmd_status() {
  local inst
  inst=$(db_instance_json)

  echo "── Dev stack ─────────────────────────────────────────────"
  if [ "$inst" = none ]; then
    echo "RDS      paused (instance not found)"
  else
    jq -r '.DBInstances[0] | "RDS      \(.DBInstanceStatus), created \(.InstanceCreateTime)"' <<<"$inst"
  fi
  local svc
  svc=$(service_status)
  echo "Service  $svc"
  if [ "$svc" = ACTIVE ]; then
    echo "Image    $(live_image || echo '?')"
  fi

  echo
  echo "── Auto-teardown ─────────────────────────────────────────"
  local mode keep instance_arg
  mode=$(gh_var DEV_AUTO_TEARDOWN)
  keep=$(gh_var DEV_KEEP_ALIVE_UNTIL)
  echo "DEV_AUTO_TEARDOWN     ${mode:-<unset>}"
  echo "DEV_KEEP_ALIVE_UNTIL  ${keep:-<unset>}"
  if [ "$inst" = none ]; then instance_arg=none; else instance_arg=-; fi
  local decision
  decision=$(DEV_AUTO_TEARDOWN="$mode" DEV_KEEP_ALIVE_UNTIL="$keep" \
    node "$TEARDOWN_JS" gate --instance-json "$instance_arg" --json <<<"$inst" || true)
  echo "Next scheduled run    $(jq -r '"\(.action): \(.reason)"' <<<"$decision")"
  command -v gh >/dev/null || echo "(gh not found — switches not read; the decision above assumes they are unset)"

  echo
  echo "── Manual snapshots (newest first) ───────────────────────"
  manual_snapshots_json | jq -r '
    .DBSnapshots
    | sort_by(.SnapshotCreateTime) | reverse
    | .[]
    | [ .DBSnapshotIdentifier, .Status, .SnapshotCreateTime,
        ((.TagList // []) | map(select(.Key == "image")) | .[0].Value // "-") ]
    | @tsv' | column -t -s $'\t'
}

cmd_resume() {
  local snapshot="" image="" extra=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --snapshot) snapshot=${2:?--snapshot needs an id}; shift 2 ;;
      --image) image=${2:?--image needs a ref}; shift 2 ;;
      --) shift; extra=("$@"); break ;;
      *) die "resume: unknown argument '$1'" ;;
    esac
  done

  if [ "$(db_instance_json)" != none ]; then
    [ "$(service_status)" = ACTIVE ] &&
      die "RDS instance $DB_INSTANCE exists — the stack is not paused. Nothing to resume."
    die "RDS instance $DB_INSTANCE exists but service $SERVICE is not ACTIVE: dev is half up
(an earlier resume was interrupted or is still running). resume can't finish it. See
docs/architecture/infrastructure.md § An interrupted resume."
  fi

  local snaps chosen tagged_image
  snaps=$(manual_snapshots_json)
  if [ -n "$snapshot" ]; then
    chosen=$(jq -c --arg id "$snapshot" '.DBSnapshots[] | select(.DBSnapshotIdentifier == $id)
      | { id: .DBSnapshotIdentifier, status: .Status,
          image: ((.TagList // []) | map(select(.Key == "image")) | .[0].Value) }' <<<"$snaps")
    [ -n "$chosen" ] || die "snapshot $snapshot not found."
    [ "$(jq -r .status <<<"$chosen")" = available ] || die "snapshot $snapshot is not available."
  else
    chosen=$(node "$TEARDOWN_JS" resume-snapshot --snapshots-json - <<<"$snaps")
    snapshot=$(jq -r .id <<<"$chosen")
  fi
  tagged_image=$(jq -r '.image // empty' <<<"$chosen")

  if [ -z "$image" ]; then
    [ -n "$tagged_image" ] ||
      die "snapshot $snapshot has no 'image' tag (a manual pause snapshot?). Pass --image $IMAGE_REPO:<sha>."
    image=$tagged_image
  fi

  note "restoring from $snapshot"
  note "image $image${tagged_image:+ (snapshot was taken under $tagged_image)}"
  check_image_exists "$image"
  ensure_init

  tf apply -lock-timeout=5m "${TF_VARS[@]}" \
    -var "db_snapshot_identifier=$snapshot" \
    -var "server_image=$image" \
    "${extra[@]}"

  cat >&2 <<EOF

dev-stack: resumed. Next:
  scripts/dev-stack.sh plan        # expect "No changes"
  scripts/dev-stack.sh status      # tonight's 02:17 UTC run tears it down again
  gh variable set DEV_KEEP_ALIVE_UNTIL --body YYYY-MM-DD   # to keep it up overnight
EOF
}

# plan / apply with server_image supplied from the live service, so nobody types it and nobody
# sets it to the image from a three-month-old snapshot.
cmd_tf() {
  local action=$1 image="" extra=()
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --image) image=${2:?--image needs a ref}; shift 2 ;;
      --) shift; extra=("$@"); break ;;
      *) die "$action: unknown argument '$1' (terraform arguments go after --)" ;;
    esac
  done

  if [ -z "$image" ]; then
    if [ "$(service_status)" != ACTIVE ]; then
      die "the dev stack is paused, so there is no live image to read. A $action now would also CREATE
an EMPTY database (no snapshot restore, no breadsheet_iam role). To bring it back use:
  scripts/dev-stack.sh resume
To $action anyway (e.g. with -target), pass --image $IMAGE_REPO:<sha>."
    fi
    image=$(live_image) || die "could not read the live service's image."
  fi
  note "server_image=$image"
  ensure_init
  tf "$action" -lock-timeout=5m "${TF_VARS[@]}" -var "server_image=$image" "${extra[@]}"
}

case "${1:-}" in
  status) shift; cmd_status "$@" ;;
  resume) shift; cmd_resume "$@" ;;
  plan|apply) cmd_tf "$@" ;;
  *)
    sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
