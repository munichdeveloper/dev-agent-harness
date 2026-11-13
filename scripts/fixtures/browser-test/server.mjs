import { createServer } from 'node:http';
import process from 'node:process';
createServer((request, response) => response.writeHead(200, { 'content-type': 'text/html' })
  .end('<!doctype html><title>loopback</title><h1>served on loopback</h1>')).listen(Number(process.env.PORT), '127.0.0.1');
