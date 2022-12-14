import { camelCase } from "change-case"
import { existsSync } from "fs"
import { writeFile } from "fs/promises"
import { join, resolve } from "path"
import glob from "tiny-glob"

import { vLog, wLog } from "@plasmo/utils/logging"

import {
  addMessagingDeclaration,
  createDeclarationCode
} from "~features/background-service-worker/bgsw-messaging-declaration"
import { getMd5RevHash } from "~features/helpers/crypto"
import { toPosix } from "~features/helpers/path"
import type { BaseFactory } from "~features/manifest-factory/base"

const state = {
  md5Hash: ""
}

// TODO: cache these?
const createEntryCode = (
  importSection: string,
  switchCaseSection: string,
  portSection: string
) => `// @ts-nocheck
globalThis.__plasmoInternalPortMap = new Map()

${importSection}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.name) {
    ${switchCaseSection}
    default:
      break
  }

  return true
})

chrome.runtime.onConnect.addListener(function(port) {
  globalThis.__plasmoInternalPortMap.set(port.name, port)
  port.onMessage.addListener(function(request) {
    switch (port.name) {
      ${portSection}
      default:
        break
    }
  })
})

`

const getHandlerList = async (
  plasmoManifest: BaseFactory,
  dirName: "messages" | "ports"
) => {
  const handlerDir = join(
    plasmoManifest.projectPath.backgroundDirectory,
    dirName
  )

  if (!existsSync(handlerDir)) {
    return []
  }

  const handlerFileList = await glob("**/*.ts", {
    cwd: handlerDir,
    filesOnly: true
  })

  return handlerFileList.map((filePath) => {
    const posixFilePath = toPosix(filePath)
    const handlerName = posixFilePath.slice(0, -3)
    const importPath = `${dirName}/${handlerName}`
    const importName = camelCase(importPath)

    return {
      importName,
      name: handlerName,
      declaration: `"${handlerName}" : {}`,
      importCode: `import { handler as ${importName} } from "~background/${importPath}"`
    }
  })
}

const getMessageCode = (name: string, importName: string) => `case "${name}":
  ${importName}({
    sender,
    ...request
  }, {
    send: (p) => sendResponse(p)
  })
  break`

const getPortCode = (name: string, importName: string) => `case "${name}":
  ${importName}({
    port,
    ...request
  }, {
    send: (p) => port.postMessage(p)
  })
  break`

export const createBgswMessaging = async (plasmoManifest: BaseFactory) => {
  try {
    // check if package.json has messaging API
    if (!("@plasmohq/messaging" in plasmoManifest.dependencies)) {
      wLog("@plasmohq/messaging is not installed, skipping messaging API")
      return
    }

    const [messageHandlerList, portHandlerList] = await Promise.all([
      getHandlerList(plasmoManifest, "messages"),
      getHandlerList(plasmoManifest, "ports")
    ])

    vLog({ messageHandlerList, portHandlerList })

    if (messageHandlerList.length === 0 && portHandlerList.length === 0) {
      return false
    }

    const declarationCode = createDeclarationCode(
      messageHandlerList.map(({ declaration }) => declaration),
      portHandlerList.map(({ declaration }) => declaration)
    )

    const declarationMd5Hash = getMd5RevHash(Buffer.from(declarationCode))

    if (state.md5Hash === declarationMd5Hash) {
      return true
    }

    state.md5Hash = declarationMd5Hash

    const entryCode = createEntryCode(
      [...messageHandlerList, ...portHandlerList]
        .map((code) => code.importCode)
        .join("\n"),
      messageHandlerList
        .map((code) => getMessageCode(code.name, code.importName))
        .join("\n"),
      portHandlerList
        .map((code) => getPortCode(code.name, code.importName))
        .join("\n")
    )

    await Promise.all([
      writeFile(
        resolve(
          plasmoManifest.commonPath.staticDirectory,
          "background",
          "messaging.ts"
        ),
        entryCode
      ),
      addMessagingDeclaration(plasmoManifest.commonPath, declarationCode)
    ])

    return true
  } catch (e) {
    vLog(e.message)
    return false
  }
}