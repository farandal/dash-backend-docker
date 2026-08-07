#!/bin/bash

################################################################################
# PACKAGE ENVIRONMENT FILES
################################################################################
#
# This script packages all .env* files from the dash-backend-docker repository
# into a single encrypted-ready zip archive for secure sharing with teammates.
#
# USAGE:
#   ./package-envs.sh                    # Auto-generates timestamped filename
#   ./package-envs.sh envs-backup.zip    # Custom filename (timestamp added)
#
# EXAMPLES:
#   ./package-envs.sh
#   # Output: .env-backup_20260807_143022.zip
#
#   ./package-envs.sh team-envs.zip
#   # Output: team-envs_20260807_143022.zip
#
# WHAT IT DOES:
#   1. Finds all .env* files in the repository root
#   2. Creates a timestamped zip archive
#   3. Lists all packaged files
#   4. Shows security reminders
#
# IMPORTANT SECURITY NOTES:
#   ⚠️  This script does NOT encrypt the zip file. You must:
#
#   1. ENCRYPT before sharing:
#      gpg --symmetric .env-backup_*.zip        # Password-protected
#      openssl enc -aes-256-cbc -in .env-backup_*.zip -out .env-backup_*.zip.enc
#
#   2. SHARE securely via:
#      - Encrypted email (ProtonMail, etc.)
#      - Secure file transfer (Tresorit, Sync.com)
#      - Encrypted messaging with file capabilities
#      - NEVER via unencrypted Slack/Teams/Discord
#
#   3. DELETE immediately after:
#      rm .env-backup_*.zip
#      rm .env-backup_*.zip.enc (if encrypted version created)
#
#   4. VERIFY on recipient side:
#      - Run unpackage-envs.sh
#      - Check all files extracted correctly
#      - Confirm no .env files in git history
#
# WHAT FILES ARE PACKAGED:
#   - .env (repo root)
#   - .env.* (repo root)
#
# GIT SAFETY:
#   - All .env* files are in .gitignore
#   - All .env-backup*.zip files are in .gitignore
#   - Safe to run; zip files will NOT be committed
#
################################################################################

set -e

OUTPUT_FILE="${1:-.env-backup.zip}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_FILE="${OUTPUT_FILE%.zip}_${TIMESTAMP}.zip"

echo "🔐 Packaging environment files..."

# Find all .env* files in repo root only
ENV_FILES=()
while IFS= read -r -d '' file; do
  ENV_FILES+=("$file")
  echo "  ✓ Found: $file"
done < <(find . -maxdepth 1 -name '.env*' -type f -print0 2>/dev/null)

if [ ${#ENV_FILES[@]} -eq 0 ]; then
  echo "❌ No .env files found in repository root"
  exit 1
fi

echo ""
echo "📦 Creating zip archive: $OUTPUT_FILE"
zip -q "$OUTPUT_FILE" "${ENV_FILES[@]}"

FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
echo "✅ Successfully packaged ${#ENV_FILES[@]} files ($FILE_SIZE)"
echo "📍 Archive location: $OUTPUT_FILE"
echo ""
echo "⚠️  SECURITY REMINDER:"
echo "   - Keep this file secure (preferably encrypted)"
echo "   - Delete it after sharing"
echo "   - Only share with trusted team members"
echo "   - Consider using encrypted email/messaging"
