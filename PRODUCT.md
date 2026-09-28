# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Static HTML/CSS in `docs/`, served by GitHub Pages at https://softland-tech.github.io/Relay (deploy from branch `main`, folder `/docs`). No build step; all asset paths relative because Pages serves under the `/Relay` subpath.

## Users

People who want their own self-hosted AI agent reachable from their phone. Two levels: (1) the primary visitor — someone who has heard of the open-source Hermes agent and wants a phone app for it without technical depth; the site is written beginning-friendly for them, per the owner's explicit instruction; (2) developers evaluating the client, served by the GitHub repo and README rather than the site.

## Product Purpose

Relay is an open-source Expo (React Native) client for a self-hosted Hermes agent gateway. Success on the site: a visitor understands what Relay is, believes the direct-connection story, and successfully gets Hermes running and paired with Relay by following the setup page.

## Positioning

The phone talks straight to the user's own gateway over WebSocket — no third-party platform in the path, no accounts, no cloud middleman. A chat-app bot (Telegram et al.) cannot truthfully claim this: those messages transit the platform's servers. Relay also renders what plain chat text cannot: reasoning blocks, approvals as tappable cards, an automations screen, multi-computer pairing.

## Operating Context

Hermes agent (upstream: https://github.com/NousResearch/hermes-agent, MIT) installed on the user's own machine (install: `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`; gateway: `hermes gateway setup` then `hermes gateway start`). Relay currently runs as a dev build via Expo Go against a cloned repo (no store build yet — say so honestly). Pairing via `scripts/hermes-pair.sh` (QR / `hermes://connect` link / manual host+token; token = gateway dashboard session token, conventionally `~/.config/hermes-serve.env`). Away from home: Tailscale/VPN with TLS.

## Capabilities and Constraints

Client features (verified in code): streaming replies with collapsible thinking blocks; approvals/clarifications/sudo/secrets as interactive cards; multi-session sidebar with search, pin/rename/archive/delete; slash commands and skills from the gateway registry; cron automations management; voice STT/TTS via the gateway; local + optional remote push; offline outbox and lossless replay. Screenshots on hand in `docs/screenshots/` (real captures). No published binaries — installing Relay means running the Expo dev server today; never imply a store download exists.

## Brand Commitments

Name: Relay (repo SoftLand-Tech/Relay). Brand palette from the logo: near-black teal #0E181B, cyan #39CADB, ink-on-accent #0E181B. Site stays in the app's dark theme. Owner directives, binding: no emojis anywhere in UI/copy; beginning-friendly tone; not a technical/terminal aesthetic; the landing's comparison section is "Telegram bot vs Relay".

## Evidence on Hand

Real app screenshots (docs/screenshots/*.png, DOM-verified Relay branding). Upstream install commands fetched from the Hermes README 2026-09-28. No testimonials, metrics, or customer evidence — do not fabricate any.

## Product Principles

1. Plain words first: every technical term gets a one-line human gloss; commands are wrapped in steps that say what they do.
2. The direct connection is the story: the site's central proof is "your phone talks to your computer, nothing in between".
3. Honest about maturity: dev-run install, no store build, MIT, links to the real upstream.
4. The brand's calm dark world, friendly not technical: warm consumer tone inside the app's teal/cyan palette.
