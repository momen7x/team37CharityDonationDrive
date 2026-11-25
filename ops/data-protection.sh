#!/usr/bin/env bash
# Encryption at rest + backup and restore for the four DynamoDB tables (report: security controls and recovery).
#
#   bash ops/data-protection.sh encrypt                 once after deploying (safe to repeat): KMS key + encryption on every table
#   bash ops/data-protection.sh status                  shows the encryption setting and the number of backups per table
#   bash ops/data-protection.sh backup                  on-demand backup of all four tables
#   bash ops/data-protection.sh restore <Table>         restores the newest backup of <Table> into <Table>-restored and counts the items
#
# Run with Floci up:  export AWS_PROFILE=floci MSYS_NO_PATHCONV=1
# What is protected: the data in the tables (users with password hashes, campaigns, pledges, donations) is encrypted at rest
# with the customer-managed KMS key alias/charity-data. On real AWS each service role would also need kms:Decrypt and
# kms:GenerateDataKey on that key; Floci stores IAM policies but does not enforce them.
set -uo pipefail
ALIAS="alias/charity-data"
TABLES=(CharityCampaigns CharityUsers CharityPledges CharityDonations)
clean() { tr -d '\r'; }

case "${1:-status}" in
  encrypt)
    if aws kms describe-key --key-id "$ALIAS" >/dev/null 2>&1; then
      echo "KMS key $ALIAS already exists"
    else
      KEY=$(aws kms create-key --description "Charity Donation Drive data key" --query KeyMetadata.KeyId --output text | clean)
      aws kms create-alias --alias-name "$ALIAS" --target-key-id "$KEY" && echo "created KMS key $ALIAS (id starts ${KEY:0:8})"
    fi
    for t in "${TABLES[@]}"; do
      aws dynamodb update-table --table-name "$t" \
        --sse-specification "Enabled=true,SSEType=KMS,KMSMasterKeyId=$ALIAS" >/dev/null 2>&1 \
        || echo "  note: update-table did not change $t (already encrypted, or not supported here)"
      aws dynamodb update-continuous-backups --table-name "$t" \
        --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null 2>&1 \
        || echo "  note: point-in-time recovery not enabled on $t (not supported here); on-demand backups still work"
    done
    bash "$0" status
    ;;

  status)
    printf '%-18s %-12s %-10s %-22s %s\n' table encryption type key backups
    for t in "${TABLES[@]}"; do
      enc=$(aws dynamodb describe-table --table-name "$t" --query 'Table.SSEDescription.[Status,SSEType,KMSMasterKeyArn]' --output text 2>/dev/null | clean)
      [ -n "$enc" ] && [ "$enc" != "None" ] || enc="NONE NONE NONE"
      set -- $enc
      n=$(aws dynamodb list-backups --table-name "$t" --query 'length(BackupSummaries)' --output text 2>/dev/null | clean)
      printf '%-18s %-12s %-10s %-22s %s\n' "$t" "${1:-NONE}" "${2:-NONE}" "${3:-NONE}" "${n:-0}"
    done
    ;;

  backup)
    stamp=$(date +%Y%m%d-%H%M%S)
    for t in "${TABLES[@]}"; do
      st=$(aws dynamodb create-backup --table-name "$t" --backup-name "$t-$stamp" --query BackupDetails.BackupStatus --output text 2>&1 | clean)
      printf '%-18s backup %-28s %s\n' "$t" "$t-$stamp" "$st"
    done
    ;;

  restore)
    t="${2:?Usage: bash ops/data-protection.sh restore <Table>   (one of: ${TABLES[*]})}"
    arn=$(aws dynamodb list-backups --table-name "$t" --query 'sort_by(BackupSummaries,&BackupCreationDateTime)[-1].BackupArn' --output text 2>/dev/null | clean)
    { [ -n "$arn" ] && [ "$arn" != "None" ]; } || { echo "No backup found for $t. Run: bash ops/data-protection.sh backup"; exit 1; }
    target="$t-restored"
    aws dynamodb restore-table-from-backup --target-table-name "$target" --backup-arn "$arn" --query TableDescription.TableStatus --output text | clean
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      s=$(aws dynamodb describe-table --table-name "$target" --query Table.TableStatus --output text 2>/dev/null | clean)
      [ "$s" = ACTIVE ] && break; sleep 2
    done
    a=$(aws dynamodb scan --table-name "$t" --select COUNT --query Count --output text | clean)
    b=$(aws dynamodb scan --table-name "$target" --select COUNT --query Count --output text | clean)
    echo "items in $t: $a    items in $target: $b"
    [ "$a" = "$b" ] && echo "restore matches the source table" || echo "counts differ: new items were written after the backup was taken"
    ;;

  *) echo "Usage: bash ops/data-protection.sh encrypt|status|backup|restore <Table>"; exit 1 ;;
esac
