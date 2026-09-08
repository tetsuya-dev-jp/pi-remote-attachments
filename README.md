# Pi Remote Attachments

Pi extension that pulls files and directories from the Windows SSH client into
Pi running on Ubuntu.

## Architecture

This extension is designed for this workflow:

    Windows Terminal
        └─ ssh ubuntu
             └─ pi

Explorer drag-and-drop pastes a Windows path into Pi. The extension detects the
path, connects from Ubuntu to the Windows OpenSSH Server over SFTP, and stores
the result under:

    ~/.pi/attachments/<session-id>/<attachment-id>/

Pi runs on Ubuntu. No Pi installation or helper program is required on
Windows.

## Requirements

- Pi 0.85.0 or later
- Windows OpenSSH Server with its SFTP subsystem enabled
- SSH public-key authentication from Ubuntu to Windows
- Windows host key registered in the configured known-hosts file

The Windows SSH login user and the Windows profile name in a path are
independent values. Configure the account used by the Windows OpenSSH Server.

## Installation

Install directly from GitHub:

    pi install git:github.com/tetsuya-dev-jp/pi-remote-attachments

The extension can also be loaded from a local checkout:

    pi -e /path/to/pi-remote-attachments/index.ts

## Configuration

Create ~/.pi/agent/remote-attachments.json, or run /attachments setup:

    {
      "windows": {
        "host": "windows-host",
        "username": "windows-user",
        "port": 22,
        "identityFile": "~/.ssh/pi_windows_attachment",
        "knownHostsFile": "~/.ssh/known_hosts",
        "hostKeyAlias": "windows-host"
      }
    }

If host is omitted, the extension uses the client address from
SSH_CONNECTION, then SSH_CLIENT. When connecting by IP, register that address
in knownHostsFile. Unknown or changed host keys are rejected.

The default limits are 2 GiB per file, 5 GiB per directory, and three
concurrent transfers.

## Usage

1. SSH from Windows Terminal into Ubuntu.
2. Start Pi on Ubuntu.
3. Drag a file or directory from Explorer into Pi's input editor.
4. Continue writing the request and press Enter after the transfer is ready.

The Windows path is replaced with a visible attachment placeholder. The final
model input contains only the Ubuntu-side attachment path, never the original
Windows path.

Management commands:

    /attachments
    /attachments status
    /attachments dir
    /attachments remove 1
    /attachments retry 1
    /attachments cleanup
    /attachments config

## Path and transfer behavior

- Windows OpenSSH drive paths use the /C:/Users/... namespace.
- Quoted paths with spaces, Unicode names, and multiple pasted paths are
  supported.
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

The tests cover Windows path parsing, SFTP argument construction, listing
parsing, prompt transformation, configuration normalization, cleanup, and
session restore behavior.
