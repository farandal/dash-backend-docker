#!/bin/bash

################################################################################
# UNPACKAGE ENVIRONMENT FILES
################################################################################
#
# This script safely extracts .env* files from a backup zip archive created by
# package-envs.sh, with confirmation prompts to prevent accidental overwrites.
#
# USAGE:
#   ./unpackage-envs.sh <zip-filename>
#
# EXAMPLES:
#   ./unpackage-envs.sh .env-backup_20260807_143022.zip
#   ./unpackage-envs.sh team-envs_20260807_143022.zip
#
# WHAT IT DOES:
#   1. Validates the zip file exists and is valid
#   2. Lists all .env* files that will be extracted
#   3. Asks for confirmation (prevents accidental overwrites)
#   4. Extracts files to repository root
#   5. Verifies extraction success
#   6. Shows security cleanup reminders
#
# STEP-BY-STEP WORKFLOW:
#
#   RECEIVING ENCRYPTED FILE:
#   1. Receive .env-backup*.zip.enc (or gpg) file from teammate
#   2. Decrypt it:
#      gpg .env-backup_*.zip.gpg       # If GPG encrypted
#      openssl enc -aes-256-cbc -d -in .env-backup_*.zip.enc -out .env-backup_*.zip
#      # OR: just decompress if unencrypted (not recommended!)
#
#   UNPACKING:
#   3. Run this script:
#      ./unpackage-envs.sh .env-backup_20260807_143022.zip
#   4. Review the file list
#   5. Confirm extraction (press 'y')
#   6. Verify files were extracted correctly
#   7. DELETE the zip file immediately
#
#   VERIFICATION:
#   8. Verify all .env files are in repository root:
#      ls -la .env*
#   9. Do NOT commit these files (they're in .gitignore)
#   10. Test your local dev environment
#
# IMPORTANT SECURITY NOTES:
#   ⚠️  BEFORE RUNNING:
#   - Only extract files from TRUSTED teammates
#   - Verify the zip file is from a secure source
#   - Check file timestamp matches when you received it
#
#   ⚠️  AFTER UNPACKING:
#   - DELETE the zip file immediately: rm .env-backup_*.zip
#   - DELETE the encrypted version if decrypted: rm .env-backup_*.zip.enc
#   - NEVER commit .env files (they're in .gitignore)
#   - NEVER push .env files to any branch
#
#   ⚠️  BEST PRACTICES:
#   - Each developer should have their own local copy
#   - Rotate credentials periodically
#   - Use different .env files per environment (local/tunnel/staging/prod)
#   - Keep production .env files MORE secure than dev
#
# TROUBLESHOOTING:
#
#   "File not found"
#   → Make sure the zip filename is correct
#   → Check the file is in current directory
#   → Try: ls -la *.zip
#
#   "Archive is not valid"
#   → File may be corrupted during transfer
#   → Re-request from teammate or try decrypting again
#
#   "Permission denied" on .env files
#   → Files extracted successfully but you need read permissions
#   → Run: chmod 600 .env*
#
#   "Files not extracted to expected location"
#   → Run from the dash-backend-docker root directory
#   → Don't run from subdirectories
#   → Current directory matters for extraction paths
#
# GIT SAFETY:
#   - All .env* files are in .gitignore (safe)
#   - All .env-backup*.zip files are in .gitignore (safe)
#   - Running this script will NOT affect git history
#   - But DO verify git status before committing anything else
#
################################################################################

set -e

if [ $# -eq 0 ]; then
  echo "❌ Usage: $0 <zip-filename>"
  echo "Example: $0 envs-backup_20260807_123456.zip"
  exit 1
fi

ZIP_FILE="$1"

if [ ! -f "$ZIP_FILE" ]; then
  echo "❌ File not found: $ZIP_FILE"
  exit 1
fi

if [[ ! "$ZIP_FILE" == *.zip ]]; then
  echo "❌ File must be a .zip archive"
  exit 1
fi

echo "🔓 Unpacking environment files from: $ZIP_FILE"
echo ""

# List files that will be extracted
echo "📋 Files to be extracted:"
unzip -l "$ZIP_FILE" | grep '.env' | awk '{print "   " $4}'

echo ""
read -p "⚠️  This will overwrite existing .env files. Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "❌ Cancelled"
  exit 1
fi

echo ""
echo "📦 Extracting files..."
unzip -oq "$ZIP_FILE"

echo "✅ Successfully unpacked environment files"
echo ""
echo "⚠️  SECURITY REMINDER:"
echo "   - Verify all files were extracted to repository root"
echo "   - Delete the .zip file after extraction"
echo "   - Never commit .env files to git"
echo ""
echo "Files extracted:"
unzip -l "$ZIP_FILE" | grep '.env' | awk '{print "   ✓ " $4}'
