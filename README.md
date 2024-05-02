# MavFTP services node-mavlink

Mavlink is a great protocol. It's versatile and allows for quite complex workflows. One example is the [MavFTP](https://mavlink.io/en/services/ftp.html) protocol.

Why would you use it? Of course reading log files from the SD card is one possibility. But there is more. For example, you can download a virtual file that contains the list of currently running threads, or another that has a list of active serial ports!

One very special file goes by the name of `@PARAM/param.pck?withDefaults=1`. This one is virtual and contains a tightly packed list of all currently active parameters. Downloading it and decoding is like a 1000x faster than requesting each parameter separately.

## Installation

To install the package issue the following command:

```bash
$ npm install --save node-mavlink-ftp
```

## Usage

There are 2 parts: the user interface and the server-part.

### The server part

Let's get over this one really quick. It's a filter that you pipe your stream of packets. It's transparent. It will react to MavFTP packages, but will not filter them out and you'll still be able to process them if you so desire.

```typescript
import { SerialPort } from 'serialport'
import {
  MavLinkPacket,
  MavLinkPacketParser,
  MavLinkPacketSplitter
} from 'node-mavlink'

import { MavFTP } from 'node-mavlink-ftp'

const ftp = new MavFTP()

new SerialPort({ path: '/dev/ttyACM0', baudRate: 115200 })
  .pipe(new MavLinkPacketSplitter())
  .pipe(new MavLinkPacketParser())
  .pipe(ftp)
  .resume()
```

That's it! Let's now see what we can do with it.

### The client side of things

Using the `ftp` instance is quite simple. It comes with easy to understand functions such as `downloadFile(filename)` or `listDirectory()`

#### `async resetSessions()`

This async function just resets everything. It's good to call it at the start. Don't forget to `await`!

#### `async listDirectory(path: string): MavFTPDirectoryListingEntry[]`

This async function returns a list of entries containing information about files and folders under the specified path.

#### `async removeFile(filename)`

This async function removes a file. That's it - nothing more. It'll throw an error if the file wasn't there to begin with.

#### `async downloadFile(filename, progress): Buffer`

This async function downloads the content of the specified file into the buffer it returns.

## Closing thoughts

That's the first approach into making working with MavFTP approachable. It's still lacking a few parts to be complete. The burst download would be nice... I think that in the future this package will grow substantially, so stay tuned!


Happy coding!
