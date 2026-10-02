#!/usr/bin/env node
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { createServer } from "./server";

/**
 * Standalone entry point for the SexprScope language server.
 *
 * The server speaks LSP over stdio and has no dependency on VS Code, so any
 * LSP-capable editor can launch it.
 */
const connection = createConnection(ProposedFeatures.all);
createServer(connection);
