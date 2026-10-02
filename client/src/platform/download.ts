import { Platform, Share } from 'react-native';

/**
 * Hands a text file to its owner: on the web, downloaded under `fileName`;
 * on a phone, offered to the share sheet — to save it, mail it, or open it in
 * a spreadsheet — as its text, since a share sheet takes text, not a file.
 */
export async function saveText(fileName: string, text: string, type: string): Promise<void> {
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // After the browser has taken it.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return;
  }
  await Share.share({ title: fileName, message: text });
}
