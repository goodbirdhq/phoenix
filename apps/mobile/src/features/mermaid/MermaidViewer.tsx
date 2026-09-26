import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import viewerHtml from "./viewerAsset.json";
import { parseViewerMessage, shouldShowViewerSource } from "./viewerState";

type ViewerCommand =
  | { readonly type: "render"; readonly source: string; readonly theme: "light" | "dark" }
  | { readonly type: "fit" | "reset" }
  | { readonly type: "zoom"; readonly factor: 0.8 | 1.25 };

export function MermaidViewer(props: {
  readonly source: string | null;
  readonly theme: "light" | "dark";
  readonly onClose: () => void;
}) {
  const webView = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useCallback((command: ViewerCommand) => {
    // JSON is the bridge payload. Source never becomes part of the HTML document.
    webView.current?.injectJavaScript(`window.receiveMermaid(${JSON.stringify(command)});true;`);
  }, []);
  useEffect(() => {
    if (ready && props.source !== null)
      send({ type: "render", source: props.source, theme: props.theme });
  }, [ready, props.source, props.theme, send]);
  useEffect(() => {
    if (props.source === null) {
      setReady(false);
      setShowSource(false);
      setError(null);
    }
  }, [props.source]);
  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const message = parseViewerMessage(event.nativeEvent.data);
    if (message?.type === "ready") setReady(true);
    else if (message?.type === "rendered") setError(null);
    else if (message?.type === "error") setError(message.error);
  }, []);
  if (props.source === null) return null;
  const dark = props.theme === "dark";
  const color = dark ? "#f5f5f5" : "#171717";
  const background = dark ? "#171717" : "#fff";
  const sourceVisible = shouldShowViewerSource(showSource, error);
  const control = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={{ paddingHorizontal: 9, paddingVertical: 12 }}
    >
      <Text style={{ color }}>{label}</Text>
    </Pressable>
  );
  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: background, paddingTop: 34 }}>
        <View
          style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}
        >
          <Text style={{ color, fontSize: 18, marginLeft: 16, fontWeight: "600" }}>Diagram</Text>
          {control("Close", props.onClose)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center" }}>
          {control("Fit", () => send({ type: "fit" }))}
          {control("Zoom in", () => send({ type: "zoom", factor: 1.25 }))}
          {control("Zoom out", () => send({ type: "zoom", factor: 0.8 }))}
          {control("Reset", () => send({ type: "reset" }))}
          {control(error ? "Retry diagram" : showSource ? "Show diagram" : "Show source", () => {
            if (error) {
              setError(null);
              setShowSource(false);
              send({ type: "render", source: props.source ?? "", theme: props.theme });
            } else setShowSource((value) => !value);
          })}
          {control("Copy source", () => void Clipboard.setStringAsync(props.source ?? ""))}
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={{ color, padding: 12 }}>
            {error}
          </Text>
        ) : null}
        {sourceVisible ? (
          <ScrollView style={{ flex: 1, padding: 16 }}>
            <Text selectable style={{ color, fontFamily: "monospace" }}>
              {props.source}
            </Text>
          </ScrollView>
        ) : null}
        <View
          style={{
            flex: sourceVisible ? 0 : 1,
            height: sourceVisible ? 0 : undefined,
            overflow: "hidden",
          }}
        >
          <WebView
            ref={webView}
            source={{ html: viewerHtml, baseUrl: "about:blank" }}
            originWhitelist={["about:blank"]}
            onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
            onMessage={onMessage}
            onError={() => setError("Diagram viewer could not load.")}
            javaScriptEnabled
            domStorageEnabled={false}
            setSupportMultipleWindows={false}
            mixedContentMode="never"
            allowFileAccess={false}
            allowUniversalAccessFromFileURLs={false}
            style={{ flex: 1, backgroundColor: "transparent" }}
          />
        </View>
      </View>
    </Modal>
  );
}
