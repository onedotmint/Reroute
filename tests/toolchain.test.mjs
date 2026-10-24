import test from 'node:test';
import assert from 'node:assert/strict';
import { Image } from '@daytona/sdk';
import { TOOLCHAIN_IMAGE, TOOLCHAIN_BASE, TOOLCHAIN_COMMANDS } from '../dist/toolchain.js';

test('starter toolchain uses official SDK image builder with no local project build context',()=>{
 const image=Image.base(TOOLCHAIN_BASE).dockerfileCommands(TOOLCHAIN_COMMANDS);
 assert.equal(TOOLCHAIN_IMAGE,'reroute:node-rust-v1');
 assert.deepEqual(image.contextList,[]);
 assert.match(image.dockerfile,/FROM rust:1-bookworm/);
 assert.match(image.dockerfile,/COPY --from=node:22-bookworm/);
 assert.match(image.dockerfile,/python3/);
 assert.match(image.dockerfile,/npm-cli/);
 assert.ok(!image.dockerfile.includes('COPY .'));
});
