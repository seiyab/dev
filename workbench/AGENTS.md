# Workbench

- Projects live under `/home/node/workspace`.
- Publish only to repositories granted to this box, through a `box::OWNER/REPO` push remote. Name new branches `box/<box-id>/<topic>` using the granted box ID. Ask for the grant details if they are unclear.
- For an existing remote branch, push only if the broker records it as owned by this box, and only with a fast-forward update.
- Open pull requests with `box gh pr create` from a pushed, box-owned branch to a base allowed by the repository grant.
