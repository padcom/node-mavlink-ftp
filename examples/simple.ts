#!/usr/bin/env -S npx ts-node

import { writeFile } from 'fs/promises'
import { basename } from 'path'
import { SerialPort } from 'serialport'
import {
  MavLinkPacketSplitter,
  MavLinkPacketParser,
  sleep
} from 'node-mavlink'

import { Heartbeat } from 'node-mavlink-heartbeat'
import { MavFTP } from '..'

(async () => {
  const port = new SerialPort({ path: '/dev/ttyACM0', baudRate: 115200 })
  await sleep(1)

  const heartbeat = new Heartbeat(port)
  const ftp = new MavFTP(port)

  port
    .pipe(new MavLinkPacketSplitter())
    .pipe(new MavLinkPacketParser())
    .pipe(heartbeat)
    .pipe(ftp)
    .resume()

  const filename = '@PARAM/param.pck?withdefaults=1'
  console.log('Opening serial port...')

  console.log('Waiting for heartbeat from the drone...')
  await heartbeat.waitForOne()

  console.log('Resetting sessions...')
  await ftp.resetSessions()

  console.log(`Listing directory @SYS...`)
  console.log(await ftp.listDirectory('@SYS'))

  console.log('Downloading', filename, '...')
  await writeFile(basename(filename), await ftp.downloadFile(filename))

  console.log('Removing old file...')
  try {
    await ftp.removeFile('/APM/STRG_BAK/STRG2.bak')
  } catch {
    // we know this will fail, the file doesn't exist
  }

  port.close()
})()
