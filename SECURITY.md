# Security Policy

## Supported Versions

Nova-AI is under active development. Security fixes are applied to the current main branch.

## Reporting a Vulnerability

Please do not open a public issue for a suspected security vulnerability.

Report security issues privately through GitHub's repository security reporting mechanism. Include:
- a clear description of the issue;
- affected component or endpoint;
- reproduction steps or a minimal proof of concept;
- potential impact;
- any suggested mitigation, if known.

Do not include live credentials, access tokens, private keys, customer data, or other secrets in the report.

## Secret Handling

If a credential or token may have been exposed, rotate/revoke it immediately and report the exposure privately. Do not commit the exposed value or paste it into public issues, pull requests, logs, or chat.

## Scope

Security reports are especially valuable for:
- tenant isolation and authorization;
- authentication and token handling;
- webhook authenticity and replay protection;
- secret handling and encryption;
- SQL/database integrity;
- unsafe file or OCR processing;
- AI/provider access controls;
- data leakage and sensitive logging;
- dependency or CI/CD supply-chain issues.
