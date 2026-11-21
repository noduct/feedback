# Repository settings (maintainers)

Settings that live in the GitHub UI and can't be stored as files. Apply them once and review them when something changes.

## General

- **Description:** `Report bugs and suggest improvements for Noduct — free file tools that run in your browser.`
- **Website:** `https://noduct.app`
- **Topics:** `noduct`, `pdf-tools`, `privacy`, `feedback`
- **Features:**
  - Issues: on.
  - Discussions: on, with the categories *Ideas* (uses `ideas.yml`), *Q&A* and *Announcements* (maintainers only).
  - Wiki, Projects: off.
- **Pull requests:** set to "Collaborators only" (Settings → General → Pull Requests). The repository takes feedback, not code.

## Security

- **Private vulnerability reporting:** on (Settings → Code security).
- **Dependabot alerts:** on, to cover the triage workflow's pinned actions.
- **Actions:**
  - Settings → Actions → General → allow only actions from GitHub and verified creators;
  - workflow permissions default to **Read repository contents**, because `triage.yml` asks for `issues: write` on its own.
- No secrets are needed in this repository. The release mirror runs from `noduct/noduct` with its own token.

## Labels

Create the labels in `.github/labels.json`. With the GitHub CLI:

```sh
jq -c '.[]' .github/labels.json | while read -r l; do
  gh label create "$(jq -r .name <<<"$l")" --color "$(jq -r .color <<<"$l")" \
    --description "$(jq -r .description <<<"$l")" --force
done
```

## During a spam wave

1. Settings → Moderation options → **Interaction limits**: limit to "prior contributors" for 24 hours (up to 6 months).
2. Block the accounts involved (Settings → Moderation options → Blocked users). Reporting them to GitHub is optional.
3. Close the issues as *not planned* with the `possible-spam` label kept, so the triage rules can be tuned later.
