# Third-party notices

Preflight Scout depends on third-party packages that remain under their own
licenses. Package metadata and lockfile entries are not relicensed by the
Preflight Scout AGPL license.

The website self-hosts Inter and IBM Plex Mono under the SIL Open Font License
1.1 and uses Phosphor Icons under the MIT License. Deployment copies of those
license texts are kept in `apps/site/public/licenses/`.

The normal package-license inventory reports one dependency without license
metadata in its published npm tarball:

## `buffers` 0.1.1

`buffers` is an indirect dependency reached through `@actions/artifact`,
`unzip-stream`, and `binary`. Its npm 0.1.1 package does not declare a license.
The Debian source-package record identifies the upstream author and records the
package as MIT licensed, tracing that declaration to an upstream repository
commit:

- Copyright (c) 2015 James Halliday
- Source record: <https://sources.debian.org/copyright/license/node-buffers/0.1.1-2/>
- License: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
