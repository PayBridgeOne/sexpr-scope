;;;; services.lisp --- Behaviour over the payment model.

(in-package #:payment)

(defun charge-fee (transaction amount)
  "Charge AMOUNT scaled by *FEE-RATE* against TRANSACTION."
  (declare (ignore transaction))
  (* amount *fee-rate*))

(defgeneric process (object)
  (:documentation "Process an arbitrary payment OBJECT."))

(defmethod process ((transaction transaction))
  (let ((amount (transaction-amount transaction)))
    (when (> amount 100)
      (charge-fee transaction amount))))

(defun process-transaction (transaction)
  "Entry point mirroring the example in the SexprScope design docs."
  (let ((amount (transaction-amount transaction)))
    (when (> amount 100)
      (charge-fee transaction amount))))

(defmacro with-transaction ((var amount) &body body)
  "Bind VAR to a freshly created transaction of AMOUNT around BODY."
  `(let ((,var (make-instance 'transaction :amount ,amount)))
     ,@body))
