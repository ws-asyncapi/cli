export function toPascalCase(str: string) {
    return str.replace(/(?:^|_)(\w)/g, (_, char) => char.toUpperCase());
}
