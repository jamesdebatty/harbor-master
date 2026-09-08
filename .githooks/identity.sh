# The one identity every commit in this repository carries as author and committer.
#
# Both values are empty by default, which leaves your own git config in charge:
# `install` will not touch user.name or user.email, and the identity hooks stand
# down. Fill them in to pin every commit in this clone to a single identity —
# useful when agents commit on your behalf and you want one author on the record.
#
# Prefer `.githooks/identity.local.sh` over editing this file. It is gitignored,
# it overrides these values, and it keeps a configured clone free of a dirty
# tracked file. Whatever you choose, edit one place and nowhere else.
GIT_IDENTITY_NAME=""
GIT_IDENTITY_EMAIL=""
