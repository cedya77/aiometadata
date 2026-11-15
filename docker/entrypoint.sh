#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later WITH AdditionRef-AIOMetadata-FSL-linking
# Copyright (C) 2021-2026 cedya77 and AIOMetadata contributors, see NOTICE
set -e

exec node dist/server/server.js
