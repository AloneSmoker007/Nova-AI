# Nova X2.0 — UI/UX Master Specification

Status: design/implementation contract
Base: main @ 7a997fcd1338ff706e12d300a3b89b50464fc7a0

## Product direction

Nova X2.0 is a premium business workspace with a clean professional SaaS foundation, futuristic AI personality, and restrained luxury. It must feel fast, trustworthy, useful, and unmistakably Nova.

Design ratio:
- ~80% clean, readable product UI
- ~15% futuristic AI personality
- ~5% luxury/glass accent

Do not turn the UI into a gaming/neon interface. Readability, accessibility, performance, and business usefulness take priority.

## Visual system

Core palette:
- Deep charcoal: primary dark surfaces/background
- Nova Blue: primary actions and brand identity
- Electric Violet: AI/intelligence emphasis
- Soft Cyan: Nova Robo/live state emphasis
- Emerald: success
- Amber: warning
- Coral/Red: error
- Glass surfaces: restrained translucent white/blue with blur and thin borders

Dark and light themes are required. Accent/glow use must be selective.

Glass is limited to high-value surfaces such as dashboard metric cards, Nova Robo/AI panels, command center, selected modals and notifications. Conversation content remains highly readable and mostly solid.

## Global shell

Desktop:
- Collapsible left navigation
- Main workspace
- Contextual right intelligence panel where useful
- Persistent but compact Nova identity

Navigation:
- Dashboard
- Inbox
- Customers
- AI Assistant
- Appointments
- Payments
- Automations
- Analytics
- Settings

Global:
- Command Center via Ctrl/Cmd+K
- Search and fast navigation
- Consistent loading, empty, error and success states
- Keyboard navigation
- Responsive desktop/tablet/mobile layouts
- Reduce Motion
- Battery Saver
- Performance-aware 60/90/120/144Hz-friendly transitions
- No CPU-heavy animated backgrounds

## Dashboard

Dashboard is Nova's business command center, not a decorative analytics page.

Show real backend data only:
- Messages
- Leads
- AI replies/usage
- Appointments
- Revenue/payment context where available
- Follow-up workload
- Nova Intelligence briefing
- WhatsApp/AI/system health
- Quick actions

Nova Intelligence should surface actionable items such as unanswered customers, follow-ups, appointments and other supported backend signals.

## Inbox

Inbox is the hero workspace.

Three-column desktop layout:
1. Conversation list
2. Conversation/chat
3. Customer/Nova Intelligence context

Capabilities:
- Search
- Unread
- Needs reply
- AI handled / Human handled
- Labels/tags
- Pin/archive/mute/snooze where supported
- Star/bookmark important messages
- Conversation notes
- Follow-up state
- Customer memory
- AI signals
- Appointment/payment context
- Retry/error states
- Deleted-message durable state
- AI pause/human takeover visibility

Chat must remain readable and familiar. Avoid excessive glass effects.

## Smart Reply Composer

Provide:
- Generate
- Rewrite
- Shorter
- Professional
- Friendly
- Translate
- Fix Tone
- Ask Nova

AI-generated drafts must be previewable/editable before sending. Human control remains explicit.

## Customer Memory / Nova Brain

Customer view must combine:
- Profile
- Useful durable memory
- Conversation summary
- Important preferences/facts
- AI signals
- Appointments
- Payments
- Notes
- Tags
- Previous interactions
- Suggested next action

Memory principles:
- Store useful durable facts, not indiscriminate AI context
- Retrieve only relevant memory for each task
- View/edit/correct/delete memory
- Preserve tenant isolation
- Respect retention/privacy controls
- Never expose another tenant's memory

## Nova AI Assistant / app control

Nova must support natural-language interaction with the application.

Architecture contract:
Intent -> permission check -> safe action -> verification -> audit/event -> UI update

Safe preference/UI actions may be automatic:
- Theme
- Layout
- Filters
- Language
- Notification preferences
- AI tone/personality

Business-impact actions require confirmation where appropriate:
- Send message
- Change automation
- Cancel appointment
- Modify payment-related data
- Bulk changes

Critical/security actions require explicit confirmation and appropriate authentication:
- Credentials/secrets
- WhatsApp connection/security settings
- Permissions/roles
- Backup deletion
- Destructive data actions

Nova must never have unrestricted hidden control.

## Nova Robo

Nova Robo is the visual identity of the product, not a childish mascot.

Style:
- Premium futuristic
- Friendly but professional
- Rounded, clean geometry
- Expressive eyes/face
- Subtle Nova Blue/Violet/Cyan lighting
- No excessive neon

States:
- Ready
- Welcome
- Thinking
- Generating
- Sending
- Success
- Warning
- Error
- Idle
- Secure

Customization:
- Size
- Position
- Theme/accent
- Accessories
- Animation intensity
- Reduce Motion/Battery Saver behavior

Robo must never obstruct core business work.

## Useful WhatsApp-style productivity features

Add only features that are useful, safe, maintainable, and compatible with the official WhatsApp platform model.

Include where supported by backend/product scope:
- Pin/archive/mute/snooze
- Labels/folders/views
- Star/bookmark
- Advanced search/filtering
- Quick replies/templates
- Business hours/greeting/away workflows
- Follow-up reminders
- Appointment reminders
- Payment reminders
- Message summarization
- Translation
- Message-to-task/action extraction
- OCR/document understanding
- Voice transcription
- Media understanding
- Focus/DND controls
- Notification controls
- Activity history
- Safe undo where feasible
- Bulk organization tools with confirmation for impactful changes

Do NOT implement:
- Anti-ban/detection bypass
- Spam automation
- Unauthorized scraping
- Encryption/security bypass
- Fake presence/read/typing manipulation intended to deceive or evade platform controls
- Any feature that materially increases WhatsApp account risk

## Analytics

Analytics must use real data:
- Conversation volume
- AI activity/usage
- Lead/follow-up activity
- Appointment activity
- Payment/revenue data where available
- Operational health

No fabricated metrics.

## Notifications

Notification center should cover supported events:
- New lead
- Failed message
- Appointment
- Payment
- AI usage/limit
- WhatsApp issue
- System/security warning

Provide sensible grouping, read/unread state, quiet/focus controls and links to the relevant workspace.

## Themes/customization

Provide:
- Nova Dark
- Nova Light
- Midnight
- Aurora
- Minimal

Also:
- Accent customization within accessible contrast limits
- Wallpaper/background options
- Chat density
- Text sizing
- Animation intensity
- Reduce Motion
- Battery Saver

Customization must not break readability or accessibility.

## Security and trust UX

Show understandable status indicators for:
- Tenant isolation/protected state
- Session/security state
- WhatsApp connection
- AI readiness
- Queue/processing health
- Backup status where exposed

Never display secrets, tokens, credentials or sensitive infrastructure data in the UI.

## Accessibility

Required:
- Keyboard navigation
- Visible focus
- Accessible labels
- Contrast-safe themes
- Larger text support
- Reduce Motion
- Screen-reader-friendly structure
- Do not rely on color alone for status

## Performance

- Avoid unnecessary re-renders
- Lazy-load heavy views/media
- Virtualize long conversation lists where needed
- Debounce search
- Keep animations lightweight
- Respect Battery Saver/Reduce Motion
- Do not preload expensive AI/media features unnecessarily
- Preserve fast initial load

## Architecture constraints

- Do not redesign the production backend merely to create UI.
- Consume existing APIs/services and extend only when a required UI capability is genuinely missing.
- Preserve tenant isolation, idempotency, security, retention and usage limits.
- Keep new functionality modular.
- No frontend secrets.
- No fake buttons or fake backend data.
- No destructive changes without explicit safety review.
- Every implementation PR must include regression tests appropriate to the changed behavior, lint/syntax/build verification, and a focused diff.

## Implementation order

1. Frontend foundation/theme/token system
2. Global shell/navigation/responsive behavior
3. Dashboard
4. Inbox
5. Customer Memory
6. AI Assistant / Ask Nova
7. Smart Reply Composer
8. Nova Robo
9. Appointments / Payments / Automations views
10. Analytics
11. Notifications
12. Settings/security/health
13. Themes/customization
14. Accessibility/performance pass
15. End-to-end UI smoke verification

This document is the design contract for X2.0. Feature additions are allowed when they satisfy the useful + safe + maintainable rule; previously agreed X2.0 features should not be removed merely for simplicity.
