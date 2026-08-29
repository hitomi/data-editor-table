export type DataGridTextTransformMode = 'set' | 'affix' | 'replace'

export type DataGridTextTransformConfig = {
  mode: DataGridTextTransformMode
  value: string
  prefix: string
  suffix: string
  find: string
  replacement: string
  useRegex: boolean
}

export function createDataGridTextTransform(
  config: DataGridTextTransformConfig,
): {
  error: string | null
  transform: (value: string) => string
} {
  if (config.mode === 'set') {
    return { error: null, transform: () => config.value }
  }

  if (config.mode === 'affix') {
    return {
      error:
        config.prefix || config.suffix ? null : '输入前缀、后缀或两者。',
      transform: (value) => `${config.prefix}${value}${config.suffix}`,
    }
  }

  if (!config.find) {
    return {
      error: config.useRegex ? '输入正则表达式。' : '输入要查找的文本。',
      transform: (value) => value,
    }
  }

  if (!config.useRegex) {
    return {
      error: null,
      transform: (value) => value.split(config.find).join(config.replacement),
    }
  }

  try {
    const pattern = new RegExp(config.find, 'g')
    return {
      error: null,
      transform: (value) => value.replace(pattern, config.replacement),
    }
  } catch {
    return {
      error: '正则表达式无效。',
      transform: (value) => value,
    }
  }
}
