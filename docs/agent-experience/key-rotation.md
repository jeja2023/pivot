# Encryption Key Rotation

Use `OLD_DATA_ENCRYPTION_KEY` and `NEW_DATA_ENCRYPTION_KEY` during a maintenance window, run `node scripts/rotate-encryption-key.js`, verify the encrypted-column counts and a credential/model read, then restart Pivot with only the new key. Keep the old key in an offline recovery vault until backup restore verification completes. The script never prints plaintext or ciphertext.
