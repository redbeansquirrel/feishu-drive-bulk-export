# Security and privacy

## Supported scope

This project automates exports that the currently signed-in Feishu account is already allowed to perform. It must not be used to bypass access controls, collect another user's credentials, or export data without authorization.

## Sensitive local data

Task manifests and `.url` shortcuts contain document URLs and tokens. Exported files, reports, screenshots, browser storage, and logs can contain organization-confidential information. Keep these artifacts outside the repository and review them before sharing.

The extension does not read cookies or store passwords. It temporarily reuses CSRF and required business request headers observed during a normal user-initiated export; these session values expire when Chrome exits.

## Reporting a vulnerability

Open a GitHub security advisory when the repository enables private vulnerability reporting. Do not attach real document links, tokens, tenant domains, credentials, exported content, or unredacted logs. Provide a minimal reproduction using placeholder data.

## Platform stability

The project depends on undocumented Feishu web endpoints and DOM structures. Treat every upgrade as untrusted until a small authorized sample has been exported and inspected.
