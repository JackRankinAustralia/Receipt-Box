import Capacitor

class ReceiptGoViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        if #available(iOS 15.0, *) {
            bridge?.registerPluginInstance(ReceiptGoStoreKitPlugin())
        }
    }
}
