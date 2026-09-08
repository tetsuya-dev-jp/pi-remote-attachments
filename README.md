# Pi Remote Attachments

Ubuntu上のPiから、Windows TerminalのSSH接続元へSFTPで接続し、Explorerから貼り付けられたWindowsパスをUbuntu側へ取得するPi拡張。

## 前提

- PiはUbuntu上で起動する。
- Windows側でOpenSSH ServerとSFTP subsystemを有効にする。
- UbuntuからWindowsへ、パスワードなしのSSH公開鍵認証を設定する。
- ~/.ssh/known_hosts にWindowsのホスト鍵を登録する。

WindowsのSSHログインユーザーと、パスに含まれるWindows profile名は別物。実際のSSHログインユーザーを設定する。

## インストール

    pi install git:github.com/tetsuya-dev-jp/pi-remote-attachments

## 設定
~/.pi/agent/remote-attachments.json を作る。/attachments setup または /attachments config でも設定できる。

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

host を省略すると SSH_CONNECTION、次に SSH_CLIENT のclient IPを使う。IPで接続する場合は、そのIPのホスト鍵を knownHostsFile に登録する。未知または変更されたホスト鍵は拒否する。

## 使い方

1. Windows Terminalから通常どおりUbuntuへSSHする。
2. Ubuntu上で pi を起動する。
3. ExplorerからファイルまたはフォルダをPiの入力欄へD&Dする。
4. 転送完了後、依頼文を書いてEnterする。

入力された C:\... は最終プロンプトへ渡さず、~/.pi/attachments/<session>/<attachment>/ のUbuntuパスへ置換する。

管理コマンド:

    /attachments
    /attachments status
    /attachments dir
    /attachments remove 1
    /attachments retry 1
    /attachments cleanup
    /attachments config

Windows OpenSSH SFTPのドライブパスは /C:/Users/... として送る。Linuxの /mnt/c へは変換しない。

SFTPがsymlinkとして返した項目は追跡しない。読めないdirectory listingはskipせず転送失敗にする。

## 開発チェック

    node --experimental-strip-types --test tests/*.test.ts

単体テストはパス解析、SFTP引数、状態復元を確認する。実機確認では、Windows上のファイルをSFTPで取得し、サイズとSHA-256を比較する。
