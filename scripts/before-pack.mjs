/** 语音助手由 swiftc 按本机架构编译，打别的系统/架构会带上不能运行的二进制。 */
export async function beforePack(context) {
  const { Arch } = await import('builder-util')
  if (context.electronPlatformName !== process.platform || Arch[context.arch] !== process.arch) {
    throw new Error('只支持在目标系统/架构上打包：原生语音助手按本机架构编译')
  }
}

export default beforePack
