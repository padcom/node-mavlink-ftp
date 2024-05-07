import { Transform, TransformOptions, TransformCallback, Writable } from 'stream'
import {
  uint8_t, uint16_t, uint32_t,
  MavLinkPacket,
  MavLinkProtocol,MavLinkProtocolV2,
  send,
} from 'node-mavlink'
import { common } from 'mavlink-mappings'
import { waitForEvent } from 'node-mavlink-utils'

/**
 * MavFTP filter options
 */
export interface MavFTPOptions {
  /** Protocol (MavLinkProtocolV2 by default) */
  protocol?: MavLinkProtocol
  /** Number of retries before giving up */
  retires?: number
}

/**
 * Format of the <code>payload<code> data of <code>FileTransferProtocol</code>
 * message.
 */
export interface FileTransferProtocolPayload {
  /**
   * All new messages between the GCS and drone iterate this number.
   * Re-sent commands/ACK/NAK should use the previous response's sequence number.
   */
  seq: uint16_t
  /**
   * Session id for read/write operations (the server may use this to reference the file handle
   * and information about the progress of read/write operations).
   */
  session: uint8_t
  /**
   * Ids for particular commands and ACK/NAK messages.
   */
  opcode: common.MavFtpOpcode
  /**
   * Depends on OpCode. For Reads/Writes this is the size of the data transported.
   * For NAK it is the number of bytes used for error information (1 or 2).
   */
  size: uint8_t
  /**
   * OpCode (of original message) returned in an ACK or NAK response.
   */
  reqOpcode?: common.MavFtpOpcode
  /**
   * Code to indicate if a burst is complete. 1: set of burst packets complete, 0: More burst packets coming.
   * - Only used if req_opcode is BurstReadFile.
   */
  burstComplete: uint8_t
  /**
   * Offsets into data to be sent for ListDirectory and ReadFile commands.
   */
  offset?: uint32_t
  /**
   * Command/response data. Varies by OpCode. This contains the path for operations that act on a file or directory.
   * For an ACK for a read or write this is the requested information.
   * For an ACK for a OpenFileRO operation this is the size of the file that was opened.
   * For a NAK the first byte is the error code and the (optional) second byte may be an error number.
   */
  data: Uint8Array
}

/**
 * Grouping class for serialization and deserialization of FTP protocol payload
 */
export class FileTransferProtocolPayloadSerializer {
  /**
   * Serialize FTP protocol payload to buffer
   *
   * @param payload payload to serialize
   * @returns serialized payload
   */
  serialize(payload: FileTransferProtocolPayload): Buffer {
    const result = Buffer.from(new Uint8Array(12 + payload.data.length))
    result.writeUInt16LE(payload.seq, 0)
    result.writeUInt8(payload.session, 2)
    result.writeUInt8(payload.opcode, 3)
    result.writeUInt8(payload.size, 4)
    result.writeUInt8(payload.reqOpcode || 0, 5)
    result.writeUInt8(payload.burstComplete, 6)
    result.writeUInt8(0, 7)
    result.writeUInt32LE(payload.offset || 0, 8)
    for (let i = 0; i < payload.data.length; i++) result.writeUInt8(payload.data[i], 12 + i)

    return result
  }

  /**
   * Serialize buffer to FTP protocol payload
   *
   * @param buffer buffer with FTP protocol data
   * @returns deserialized payload
   */
  deserialize(buffer: Buffer): FileTransferProtocolPayload {
    const size = buffer.readUInt8(4)
    const result: FileTransferProtocolPayload = {
      seq: buffer.readUInt16LE(0),
      session: buffer.readUInt8(2),
      opcode: buffer.readUInt8(3),
      size,
      reqOpcode: buffer.readUInt8(5),
      burstComplete: buffer.readUInt8(6),
      offset: buffer.readUInt32LE(8),
      data: new Uint8Array(size),
    }
    for (let i = 0; i < result.data.length; i++) result.data[i] = buffer.readUInt8(12 + i)

    return result
  }
}

export type MavFTPDirectoryListingEntryType = 'file' | 'directory'

export interface MavFTPDirectoryListingEntry {
  type: MavFTPDirectoryListingEntryType
  name: string
  size: number | null
}

enum MavFTPDirectoryListingParserState {
  TYPE       = 0,
  FILE_NAME  = 1,
  SIZE       = 2,
  DIR_NAME   = 3,
  STORE      = 5,
}

export class MavFTPDirectoryListingParser {
  parse(data: Uint8Array): MavFTPDirectoryListingEntry[] {
    const result = [] as MavFTPDirectoryListingEntry[]
    let state = 0
    let entry = { type: '', name: '', size: '' }
    for (let i = 0; i < data.length; i++) {
      switch (state) {
        case MavFTPDirectoryListingParserState.TYPE:
          switch (data[i]) {
            case 70:
              // "F" (70) - for file
              entry.type = 'file'
              state = 1
              break
            case 68:
              // "D" (68) - for directory
              entry.type = 'directory'
              state = 3
              break;
            default:
              throw new Error(`Unknown entry type: ${data[i]}`)
          }
          break;
        case MavFTPDirectoryListingParserState.FILE_NAME:
          if (data[i] === 9) {
            state = 2
          } else {
            entry.name += String.fromCharCode(data[i])
          }
          break
        case MavFTPDirectoryListingParserState.SIZE:
          if (data[i] === 0) {
            state = 5
          } else {
            entry.size += String.fromCharCode(data[i])
          }
          break
        case MavFTPDirectoryListingParserState.DIR_NAME:
          if (data[i] === 0) {
            state = 5
          } else {
            entry.name += String.fromCharCode(data[i])
          }
          break
        case MavFTPDirectoryListingParserState.STORE:
          state = 0
          result.push({
            type: entry.type as MavFTPDirectoryListingEntryType,
            name: entry.name,
            size: entry.type === 'file' ? parseInt(entry.size) : null
          })
          entry = { type: '', name: '', size: '' }
          break
      }
    }

    return result
  }
}

/**
 * Type defining arguments for a progress callback
 */
export type ProgressCallback = (offset: number, totalSize: number) => void

/**
 * Extra options for downloadFile
 */
export interface DownloadFileOptions {
  onProgress?: ProgressCallback
}

/**
 * Error codes for MavFTP when returned opcode is 129
 */
export enum FileTransferProtocolError {
  None                = 0,
  Fail                = 1,
  FailErrno           = 2,
  InvalidDataSize     = 3,
  InvalidSession      = 4,
  NoSessionsAvailable = 5,
  EOF                 = 6,
  UnknownCommand      = 7,
  FileExists          = 8,
  FileProtected       = 9,
  FileNotFound        = 10,
}

export class MavFTP extends Transform {
  private readonly protocol: MavLinkProtocol
  private readonly serializer = new FileTransferProtocolPayloadSerializer()
  private readonly textEncoder = new TextEncoder()
  private session: number = 1
  private sequence: number = 0

  constructor(
    private readonly port: Writable,
    options: TransformOptions & MavFTPOptions = {
      retires: 6,
    }
  ) {
    super({ objectMode: true, ...options })

    this.protocol = options.protocol || new MavLinkProtocolV2()
  }

  _transform(packet: MavLinkPacket, encoding: string, callback: TransformCallback) {
    if (packet.header.msgid === common.FileTransferProtocol.MSG_ID) {
      const ftp = packet.protocol.data(packet.payload, common.FileTransferProtocol)
      const payload = this.serializer.deserialize(Buffer.from(ftp.payload))
      this.sequence = payload.seq
      this.emit('ftp', payload)
    }

    callback(null, packet)
  }

  private packet(
    opcode: common.MavFtpOpcode,
    data: Uint8Array | string | number = new Uint8Array(0),
    offset = 0,
    {
      targetNetwork = 0,
      targetSystem = 1,
      targetComponent = 1,
    } = {}
  ): common.FileTransferProtocol {
    const result: common.FileTransferProtocol = new common.FileTransferProtocol()
    result.targetNetwork = targetNetwork
    result.targetSystem = targetSystem
    result.targetComponent = targetComponent

    result.payload = [...this.serializer.serialize({
      seq: this.sequence,
      session: this.session,
      opcode,
      size: typeof data === 'number' ? data : data.length,
      burstComplete: 0,
      data: typeof data === 'string'
        ? this.textEncoder.encode(data)
        : typeof data === 'number'
        ? new Uint8Array(0)
        : data,
      offset
    })]

    return result
  }

  protected async send(msg: common.FileTransferProtocol, timeout = 200, retry = 6) {
    this.sequence++
    // console.log('Sending in session', this.session, this.sequence, msg.payload)
    while (retry > 0) {
      try {
        await send(this.port, msg, this.protocol)
        const response = await waitForEvent<FileTransferProtocolPayload>(this, 'ftp', timeout)
        this.sequence = response.seq
        return response
      } catch (e: any) {
        if (--retry > 0) {
          console.log(`Retrying... (${retry} tries left)`)
        } else {
          throw new Error(`Sending MavFTP message failed: ${e.message}`)
        }
      }
    }

    throw new Error('Did not expect to land here...')
  }

  protected handleError(response?: FileTransferProtocolPayload): asserts response is FileTransferProtocolPayload {
    if (!response) throw new Error('no response')
    if (response.opcode === common.MavFtpOpcode.NAK) {
      if (response.data[0] === 2) {
        throw new Error(`Filesystem error (${response.data[0]})`)
      } else {
        throw new Error(FileTransferProtocolError[response.data[0]])
      }
    }
  }

  async resetSessions() {
    const response = await this.send(this.packet(common.MavFtpOpcode.RESETSESSION))
    this.handleError(response)
    if (response.opcode === common.MavFtpOpcode.ACK) {
      this.session = 2
    }

    return response
  }

  async listDirectory(folder: string = '/') {
    const result = [] as MavFTPDirectoryListingEntry[]
    while (true) {
      const response = await this.send(this.packet(common.MavFtpOpcode.LISTDIRECTORY, folder, result.length))
      if (response.opcode === common.MavFtpOpcode.ACK) {
        const entries = new MavFTPDirectoryListingParser().parse(response.data)
        entries.forEach(entry => result.push(entry))
      } else if (response.data[0] !== FileTransferProtocolError.EOF) {
        throw new Error(FileTransferProtocolError[response.data[0]])
      } else {
        break
      }
    }

    return result
  }

  private async openFileRO(path: string = '@PARAM/param.pck?withdefaults=1') {
    const response = await this.send(this.packet(common.MavFtpOpcode.OPENFILERO, path))
    this.handleError(response)

    this.session = response.session
    const size = response.size > 0 ? Buffer.from(response.data).readUInt32LE(0) : 0

    return { response, size }
  }

  private async terminateSession() {
    const response = await this.send(this.packet(common.MavFtpOpcode.TERMINATESESSION))
    this.handleError(response)

    this.session = 0

    return { response }
  }

  private reportProgress(offset: number, totalSize: number, callback?: ProgressCallback) {
    if (typeof callback === 'function') callback(offset, totalSize)
  }

  private async readFile(size: number, progressCallback?: ProgressCallback) {
    let result = Buffer.from([])
    let offset = 0
    this.reportProgress(offset, size, progressCallback)
    while (true) {
      const response = await this.send(this.packet(common.MavFtpOpcode.READFILE, 230, offset))
      if (response?.opcode === common.MavFtpOpcode.ACK) {
        result = Buffer.concat([ result, response.data ])
        offset = offset + response.data.length
        this.reportProgress(offset, size, progressCallback)
      } else if (response?.data[0] === FileTransferProtocolError.EOF) {
        this.reportProgress(size, size, progressCallback)
        return result
      } else {
        throw new Error(`Unable to read contents of file: ${response?.data[0]}`)
      }
    }
  }

  async downloadFile(filename: string, {
    onProgress = () => {},
  }: DownloadFileOptions = {}) {
    const { size } = await this.openFileRO(filename)
    try {
      // this `await` here is necessary so that try/finally can work!
      return await this.readFile(size, onProgress)
    } finally {
      await this.terminateSession()
    }
  }

  async removeFile(filename: string) {
    const response = await this.send(this.packet(common.MavFtpOpcode.REMOVEFILE, filename))
    if (response?.opcode !== common.MavFtpOpcode.ACK) {
      throw new Error(FileTransferProtocolError[response.data[0]])
    }

    return { response }
  }
}
