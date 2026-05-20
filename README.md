# Renovate Configuration

This repository contains the **shared Renovate configuration** used across all repositories in our organization.

## Purpose

Centralized Renovate config to ensure:
- Consistent dependency update behavior
- Unified versioning strategy
- Standardized PR formatting and labels
- Common security and maintenance settings

## How to Use

Add the following to your repository's `renovate.json` (or `renovate.json5`):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": [
    "local>netcracker/qubership-renovate-config"
  ]
}
