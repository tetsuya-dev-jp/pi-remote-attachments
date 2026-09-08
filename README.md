# Pi Remote Attachments

Pi extension that pulls files and directories from an SSH source host into Pi
over OpenSSH SFTP.

## Architecture

This extension supports the same workflow from Windows, macOS, Linux, WSL, and
BSD hosts:

    source host
        └─ ssh pi-host
             └─ pi

Pi connects back to the SSH source host using SFTP and stores each attachment
under:

    ~/.pi/attachments/<session-id>/<attachment-id>/

No Pi installation or helper program is required on the source host. It needs
an SSH server with its SFTP subsystem enabled.

## Requirements

- Pi 0.85.0 or later
- OpenSSH Server with its SFTP subsystem enabled on the source host
- SSH public-key authentication from Pi to the source host
- Source host key registered in the configured known-hosts file

The SSH login user and the user name in a dropped path are independent values.
Configure the account used by the source host's SSH server.

## Installation

Install directly from GitHub:

    pi install git:github.com/tetsuya-dev-jp/pi-remote-attachments

The extension can also be loaded from a local checkout:

    pi -e /path/to/pi-remote-attachments/index.ts

## Configuration

Create `~/.pi/agent/remote-attachments.json`, or run `/attachments setup`:

    {
      "source": {
        "host": "source-host",
        "username": "source-user",
        "port": 22,
        "identityFile": "~/.ssh/pi_remote_attachment",
        "knownHostsFile": "~/.ssh/known_hosts",
        "hostKeyAlias": "source-host",
        "pathStyle": "auto"
      }
    }

`pathStyle` accepts `auto`, `windows`, or `posix`. `auto` selects the adapter
from each dropped path. When `host` is omitted, the client address from
`SSH_CONNECTION`, then `SSH_CLIENT`, is used. Unknown or changed host keys are
rejected.

Multiple source profiles can be selected by SSH client address:

    {
      "source": {
        "username": "default-user",
        "pathStyle": "auto"
      },
      "sources": {
        "desktop": {
          "host": "192.0.2.10",
          "username": "windows-user",
          "pathStyle": "windows"
        },
        "laptop": {
          "host": "192.0.2.11",
          "username": "mac-user",
          "pathStyle": "posix"
        }
      }
    }

The default limits are 2 GiB per file, 5 GiB per directory, and three
concurrent transfers.

## Usage

1. SSH from source host into the Pi host.
2. Start Pi.
3. Drag a file or directory into Pi's input editor.
4. Continue writing the request and press Enter after the transfer is ready.

The dropped path is replaced with a visible attachment placeholder. The final
model input contains only the Pi-side attachment path, never the source path.

POSIX paths are detected only from bracketed paste containing one or more paths.
This prevents ordinary text such as `/api/users` from becoming an attachment.
Windows paths retain inline detection for normal pasted input. Supported POSIX
forms include quoted paths, shell-escaped spaces, Unicode names, WSL paths, and
`file://` URIs.
An incomplete bracketed-paste start sequence is passed through as ordinary
Escape input; completed paste frames are transformed without changing their
framing.

Management commands:

    /attachments
    /attachments status
    /attachments dir
    /attachments remove 1
    /attachments retry 1
    /attachments cleanup
    /attachments config

## Path and transfer behavior

- Windows OpenSSH drive paths use the `/C:/Users/...` namespace.
- POSIX paths are sent to SFTP unchanged after validation.
- Files are streamed to disk and verified by size after download.
- Directories are traversed recursively, including hidden files and empty
  directories.
- Symlinks reported by SFTP are not followed.
- Unreadable directory listings fail the attachment instead of being silently
  omitted.
- Failed transfers remove partial local data.
- Attachments use mode 700 directories and mode 600 files.

## Development

Run unit tests:

    npm test

The tests cover Windows regression paths, POSIX paths, WSL paths, shell
escaping, file URIs, false-positive prevention, SFTP argument construction,
listing parsing, prompt transformation, source profile selection,
configuration normalization, state migration, cleanup, and session restore.

GitHub Actions runs this unit-test matrix on Ubuntu, macOS, and Windows. Real
source-host SFTP transfers require an environment with configured SSH keys and
are not part of the unit-test matrix.
